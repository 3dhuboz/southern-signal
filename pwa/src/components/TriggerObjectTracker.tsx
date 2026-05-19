/**
 * TriggerObjectTracker — Tier 3 #5
 *
 * Place named objects in the scene, photograph them before the session
 * (initial position), then log periodic checks (with optional photo and
 * displacement verdict). Shows a side-by-side before/after comparator
 * when both images are available.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTriggerObject,
  deleteTriggerObject,
  listChecks,
  listTriggerObjects,
  logTriggerCheck,
  setInitialImage,
} from "../lib/db/triggerObjectRepo";
import { registerMedia } from "../lib/db/repo";
import { readFile, writeBytes } from "../lib/opfs";
import type { TriggerObject, TriggerObjectCheck, TriggerDisplacement } from "../lib/db/schema";
import { useFocusTrap } from "../hooks/useFocusTrap";
import s from "./TriggerObjectTracker.module.css";

interface TriggerObjectTrackerProps {
  investigationId: string;
}

// ── Internal state helpers ────────────────────────────────────────────────────

/** In-memory image URL cache: mediaAsset id → object URL */
const imgCache = new Map<string, string>();

async function loadImageUrl(filePath: string): Promise<string> {
  // Use filePath as key (unique per media asset)
  const cached = imgCache.get(filePath);
  if (cached) return cached;
  const file = await readFile(filePath);
  const url = URL.createObjectURL(file);
  imgCache.set(filePath, url);
  return url;
}

// ── Displaced badge ────────────────────────────────────────────────────────────

interface BadgeProps {
  displaced: TriggerDisplacement;
}

function DisplacedBadge({ displaced }: BadgeProps) {
  if (displaced === null) {
    return <span className={`${s.badge} ${s.badgeUnchecked}`}>Not checked</span>;
  }
  if (displaced === 0) {
    return <span className={`${s.badge} ${s.badgeOk}`}>No displacement</span>;
  }
  return <span className={`${s.badge} ${s.badgeDisplaced}`}>Displaced!</span>;
}

// ── Log-check modal ───────────────────────────────────────────────────────────

interface CheckModalProps {
  obj: TriggerObject;
  investigationId: string;
  onClose: () => void;
  onSaved: (check: TriggerObjectCheck) => void;
}

function CheckModal({ obj, investigationId, onClose, onSaved }: CheckModalProps) {
  const [displaced, setDisplaced] = useState<boolean | undefined>(undefined);
  const [notes, setNotes] = useState("");
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevPhotoUrlRef = useRef<string | null>(null);
  // a11y: trap focus inside the check modal. Escape forwards to onClose;
  // parent owns mount/unmount via showCheckModal.
  const trapRef = useFocusTrap<HTMLDivElement>(true, {
    onEscape: onClose,
  });

  // Revoke object URL on unmount to avoid memory leaks.
  useEffect(() => {
    return () => {
      if (prevPhotoUrlRef.current) URL.revokeObjectURL(prevPhotoUrlRef.current);
    };
  }, []);

  const handlePhotoChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (prevPhotoUrlRef.current) URL.revokeObjectURL(prevPhotoUrlRef.current);
    const url = URL.createObjectURL(file);
    prevPhotoUrlRef.current = url;
    setPhotoPreviewUrl(url);
    setPendingBlob(file);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      let imageId: string | undefined;
      let filePath: string | undefined;
      if (pendingBlob) {
        filePath = `trigger/${obj.id}/check_${Date.now()}.jpg`;
        await writeBytes(filePath, pendingBlob);
        const asset = await registerMedia({
          investigation_id: investigationId,
          media_type: "image",
          file_path: filePath,
        });
        imageId = asset.id;
      }
      const check = await logTriggerCheck({
        trigger_object_id: obj.id,
        investigation_id: investigationId,
        image_id: imageId,
        displaced,
        displacement_notes: notes.trim() || undefined,
      });
      if (filePath) checkPathCache.set(check.id, filePath);
      onSaved(check);
      onClose();
    } catch (err) {
      setError((err as Error).message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }, [obj.id, investigationId, displaced, notes, pendingBlob, onSaved, onClose]);

  return (
    <div className={s.modalBackdrop} role="dialog" aria-modal="true" aria-label="Log check" ref={trapRef} tabIndex={-1}>
      <div className={s.modal}>
        <div className={s.modalHeader}>
          <h3 className={s.modalTitle}>Log check — {obj.name}</h3>
          <button type="button" className={s.modalClose} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className={s.modalBody}>
          {/* Displacement verdict */}
          <div className={s.fieldGroup}>
            <span className={s.label}>Displaced?</span>
            <div className={s.toggleGroup}>
              <button
                type="button"
                className={[
                  s.toggleBtn,
                  displaced === undefined ? s.toggleBtnActive : "",
                ].join(" ").trim()}
                onClick={() => setDisplaced(undefined)}
              >
                Not assessed
              </button>
              <button
                type="button"
                className={[
                  s.toggleBtn,
                  displaced === false ? s.toggleBtnActive : "",
                ].join(" ").trim()}
                onClick={() => setDisplaced(false)}
              >
                No
              </button>
              <button
                type="button"
                className={[
                  s.toggleBtn,
                  displaced === true ? s.toggleBtnDisplaced : "",
                ].join(" ").trim()}
                onClick={() => setDisplaced(true)}
              >
                Yes — displaced!
              </button>
            </div>
          </div>

          {/* Notes */}
          <div className={s.fieldGroup}>
            <label className={s.label} htmlFor="check-notes">Notes (optional)</label>
            <textarea
              id="check-notes"
              className={s.textarea}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Observations, measurements, conditions…"
            />
          </div>

          {/* Check photo */}
          <div className={s.fieldGroup}>
            <span className={s.label}>Check photo (optional)</span>
            <div className={s.cameraRow}>
              <button
                type="button"
                className={s.cameraBtn}
                onClick={() => fileInputRef.current?.click()}
              >
                Take check photo
              </button>
              {photoPreviewUrl && (
                <img src={photoPreviewUrl} alt="Check preview" className={s.previewThumb} />
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={handlePhotoChange}
              />
            </div>
          </div>

          {error && <p className={s.error}>{error}</p>}
        </div>

        <div className={s.modalFooter}>
          <button type="button" className={s.btnCancel} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={s.btnSave}
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save check"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Object card ───────────────────────────────────────────────────────────────

interface ObjectCardProps {
  obj: TriggerObject;
  investigationId: string;
  onDelete: (id: string) => void;
  onCheckSaved: (objId: string, check: TriggerObjectCheck) => void;
}

function ObjectCard({ obj, investigationId, onDelete, onCheckSaved }: ObjectCardProps) {
  const [checks, setChecks] = useState<TriggerObjectCheck[]>([]);
  const [initialUrl, setInitialUrl] = useState<string | null>(null);
  const [latestCheckUrl, setLatestCheckUrl] = useState<string | null>(null);
  const [showCheckModal, setShowCheckModal] = useState(false);
  const [loadingImgs, setLoadingImgs] = useState(false);

  // Load checks on mount
  useEffect(() => {
    void listChecks(obj.id).then(setChecks);
  }, [obj.id]);

  // Resolve image URLs when obj.initial_image_id or checks change
  useEffect(() => {
    let cancelled = false;
    async function loadImages() {
      setLoadingImgs(true);
      try {
        // Initial image
        if (obj.initial_image_id) {
          // We store file_path in opfs; derive path from the pattern used at creation
          // The file_path used was trigger/<objId>/initial.jpg
          const initialPath = `trigger/${obj.id}/initial.jpg`;
          try {
            const url = await loadImageUrl(initialPath);
            if (!cancelled) setInitialUrl(url);
          } catch {
            // Image not yet stored or path mismatch — skip gracefully
          }
        } else {
          if (!cancelled) setInitialUrl(null);
        }

        // Latest check image
        const withImage = [...checks].reverse().find((c) => c.image_id);
        if (withImage) {
          // file_path pattern used in CheckModal: trigger/<objId>/check_<ts>.jpg
          // We need the actual file_path; since we stored the media asset's file_path
          // in OPFS we need a way to look it up. We encoded `image_id` as the
          // media_asset id but we stored the file under the check creation path.
          // Since we can't query media_assets here without another db import,
          // we cache the file_path alongside the check in local component state.
          // However: the check.image_id is a media_asset UUID, not the path.
          // Use the checkUrlCache stored when the check was saved.
          const cachedPath = checkPathCache.get(withImage.id);
          if (cachedPath) {
            try {
              const url = await loadImageUrl(cachedPath);
              if (!cancelled) setLatestCheckUrl(url);
            } catch {
              if (!cancelled) setLatestCheckUrl(null);
            }
          } else {
            if (!cancelled) setLatestCheckUrl(null);
          }
        } else {
          if (!cancelled) setLatestCheckUrl(null);
        }
      } finally {
        if (!cancelled) setLoadingImgs(false);
      }
    }
    void loadImages();
    return () => { cancelled = true; };
  }, [obj.initial_image_id, obj.id, checks]);

  const mostRecentCheck = checks.length > 0 ? checks[checks.length - 1] : null;
  const displaced: TriggerDisplacement = mostRecentCheck?.displaced ?? null;

  const handleCheckSaved = useCallback((check: TriggerObjectCheck) => {
    setChecks((prev) => [...prev, check]);
    onCheckSaved(obj.id, check);
  }, [obj.id, onCheckSaved]);

  const showComparator = initialUrl !== null && latestCheckUrl !== null;

  return (
    <div className={s.objectCard}>
      <div className={s.objectRow}>
        <p className={s.objectName}>{obj.name}</p>
        <DisplacedBadge displaced={displaced} />
      </div>

      {obj.description && <p className={s.objectDesc}>{obj.description}</p>}

      {/* Before/after comparator */}
      {!loadingImgs && showComparator && (
        <div className={s.comparator}>
          <div className={s.comparatorSlot}>
            <span className={s.comparatorLabel}>Before</span>
            <img src={initialUrl} alt="Before" className={s.comparatorImg} />
          </div>
          <div className={s.comparatorSlot}>
            <span className={s.comparatorLabel}>After</span>
            <img src={latestCheckUrl} alt="After (most recent check)" className={s.comparatorImg} />
          </div>
        </div>
      )}

      {/* Single thumbnail row when only one image exists */}
      {!loadingImgs && !showComparator && (initialUrl || latestCheckUrl) && (
        <div className={s.cameraRow}>
          {initialUrl && (
            <img src={initialUrl} alt="Initial position" className={s.previewThumb} />
          )}
          {latestCheckUrl && (
            <img src={latestCheckUrl} alt="Latest check" className={s.previewThumb} />
          )}
        </div>
      )}

      <div className={s.objectActions}>
        <button
          type="button"
          className={s.btnLog}
          onClick={() => setShowCheckModal(true)}
        >
          Log check
        </button>
        <button
          type="button"
          className={s.btnDelete}
          onClick={() => {
            if (window.confirm(`Delete trigger object "${obj.name}"? This cannot be undone.`)) {
              void deleteTriggerObject(obj.id).then(() => onDelete(obj.id));
            }
          }}
        >
          Delete
        </button>
      </div>

      {showCheckModal && (
        <CheckModal
          obj={obj}
          investigationId={investigationId}
          onClose={() => setShowCheckModal(false)}
          onSaved={handleCheckSaved}
        />
      )}
    </div>
  );
}

// ── Module-level cache: check id → OPFS file path (set when a check is saved)
// This bridges the gap between the UUID stored as image_id and the OPFS path.
const checkPathCache = new Map<string, string>();

// ── Main component ─────────────────────────────────────────────────────────────

export function TriggerObjectTracker({ investigationId }: TriggerObjectTrackerProps) {
  const [objects, setObjects] = useState<TriggerObject[]>([]);
  const [showForm, setShowForm] = useState(false);

  // Add-form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [pendingBlob, setPendingBlob] = useState<Blob | null>(null);
  const [pendingObjectId, setPendingObjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void listTriggerObjects(investigationId).then(setObjects);
  }, [investigationId]);

  const handlePhotoChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPhotoPreviewUrl(url);
    setPendingBlob(file);

    // If we already have a pending object (created on first photo pick), set initial image now
    if (pendingObjectId) {
      try {
        const filePath = `trigger/${pendingObjectId}/initial.jpg`;
        await writeBytes(filePath, file);
        const asset = await registerMedia({
          investigation_id: investigationId,
          media_type: "image",
          file_path: filePath,
        });
        await setInitialImage(pendingObjectId, asset.id);
        // Update the object in local state
        setObjects((prev) =>
          prev.map((o) =>
            o.id === pendingObjectId ? { ...o, initial_image_id: asset.id } : o,
          ),
        );
      } catch (err) {
        setError((err as Error).message ?? "Failed to attach photo");
      }
    }
  }, [investigationId, pendingObjectId]);

  const handleTakeInitialPhoto = useCallback(async () => {
    // We need the object ID before the photo is taken so the file_path
    // can be constructed. Create a pending object now if the name is set,
    // else just open the file picker (the blob will be attached on save).
    if (name.trim() && !pendingObjectId) {
      try {
        const obj = await createTriggerObject({
          investigation_id: investigationId,
          name: name.trim(),
          description: description.trim() || undefined,
        });
        setPendingObjectId(obj.id);
        setObjects((prev) => [...prev, obj]);
      } catch (err) {
        setError((err as Error).message ?? "Failed to create object");
        return;
      }
    }
    fileInputRef.current?.click();
  }, [investigationId, name, description, pendingObjectId]);

  const resetForm = useCallback(() => {
    setName("");
    setDescription("");
    setPhotoPreviewUrl(null);
    setPendingBlob(null);
    setPendingObjectId(null);
    setError(null);
    setShowForm(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let objId = pendingObjectId;
      let obj: TriggerObject;

      if (objId) {
        // Object was already created (photo was taken first); update description if needed
        const existing = objects.find((o) => o.id === objId);
        if (!existing) throw new Error("Object not found in state");
        obj = existing;
      } else {
        // Create fresh
        obj = await createTriggerObject({
          investigation_id: investigationId,
          name: name.trim(),
          description: description.trim() || undefined,
        });
        objId = obj.id;
        setObjects((prev) => [...prev, obj]);
      }

      // Attach initial photo if there's a pending blob and we haven't stored it yet
      if (pendingBlob && !obj.initial_image_id) {
        const filePath = `trigger/${objId}/initial.jpg`;
        await writeBytes(filePath, pendingBlob);
        const asset = await registerMedia({
          investigation_id: investigationId,
          media_type: "image",
          file_path: filePath,
        });
        await setInitialImage(objId, asset.id);
        setObjects((prev) =>
          prev.map((o) => (o.id === objId ? { ...o, initial_image_id: asset.id } : o)),
        );
      }

      resetForm();
    } catch (err) {
      setError((err as Error).message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  }, [name, description, pendingObjectId, pendingBlob, objects, investigationId, resetForm]);

  const handleDelete = useCallback((id: string) => {
    setObjects((prev) => prev.filter((o) => o.id !== id));
  }, []);

  const handleCheckSaved = useCallback((_objId: string, _check: TriggerObjectCheck) => {
    // checkPathCache is populated by CheckModal.handleSave before onSaved fires.
  }, []);

  return (
    <section className={s.wrap}>
      <div className={s.header}>
        <h2 className={s.heading}>Trigger Objects</h2>
        {!showForm && (
          <button
            type="button"
            className={s.addBtn}
            onClick={() => setShowForm(true)}
          >
            Add object
          </button>
        )}
      </div>

      {/* Add-object form */}
      {showForm && (
        <div className={s.addForm}>
          <div className={s.fieldGroup}>
            <label className={s.label} htmlFor="to-name">
              Name<span className={s.required}>*</span>
            </label>
            <input
              id="to-name"
              type="text"
              className={s.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Rosary beads, Bell, Coin"
              autoFocus
            />
          </div>

          <div className={s.fieldGroup}>
            <label className={s.label} htmlFor="to-desc">Description (optional)</label>
            <textarea
              id="to-desc"
              className={s.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Location in room, condition, orientation…"
            />
          </div>

          <div className={s.fieldGroup}>
            <span className={s.label}>Initial photo (optional)</span>
            <div className={s.cameraRow}>
              <button
                type="button"
                className={s.cameraBtn}
                disabled={!name.trim()}
                title={!name.trim() ? "Enter a name first" : undefined}
                onClick={() => void handleTakeInitialPhoto()}
              >
                Take initial photo
              </button>
              {photoPreviewUrl && (
                <img src={photoPreviewUrl} alt="Initial photo preview" className={s.previewThumb} />
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={(e) => void handlePhotoChange(e)}
              />
            </div>
          </div>

          {error && <p className={s.error}>{error}</p>}

          <div className={s.formFooter}>
            <button
              type="button"
              className={s.btnCancel}
              onClick={resetForm}
            >
              Cancel
            </button>
            <button
              type="button"
              className={s.btnSave}
              disabled={!name.trim() || saving}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : "Save object"}
            </button>
          </div>
        </div>
      )}

      {/* Object list */}
      <div className={s.objectList}>
        {objects.length === 0 && !showForm && (
          <p className={s.empty}>No trigger objects yet. Add one before the session begins.</p>
        )}
        {objects.map((obj) => (
          <ObjectCard
            key={obj.id}
            obj={obj}
            investigationId={investigationId}
            onDelete={handleDelete}
            onCheckSaved={handleCheckSaved}
          />
        ))}
      </div>
    </section>
  );
}
