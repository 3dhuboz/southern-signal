/**
 * EvpReview — list every audio media asset across investigations,
 * capture new clips, and open the editor for forensic review.
 *
 * Honest framing: this is a forensic-grade audio editor. It does not
 * make subjective claims about whether a clip is paranormal — it lets
 * a reviewer mark Class A/B/C and links every action to the audit
 * chain so the final classification is defensible in post.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { query } from "../lib/db/db";
import type { Investigation, MediaAsset } from "../lib/db/schema";
import { useSession } from "../lib/session";
import { EvpRecorderControl } from "../components/EvpRecorderControl";
import { EvpEditor } from "../components/EvpEditor";
import s from "./View.module.css";
import r from "./EvpReview.module.css";

interface AudioAssetRow extends MediaAsset {
  investigation_title: string | null;
}

export function EvpReview() {
  const session = useSession();
  const [rows, setRows] = useState<AudioAssetRow[]>([]);
  const [openAsset, setOpenAsset] = useState<MediaAsset | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [filterMineOnly, setFilterMineOnly] = useState(false);

  const refresh = useCallback(() => setReloadTick((t) => t + 1), []);

  useEffect(() => {
    void (async () => {
      const audioRows = await query<MediaAsset>(
        "SELECT * FROM media_assets WHERE media_type = 'audio' ORDER BY timestamp_start DESC LIMIT 200",
      );
      const inv = await query<Investigation>("SELECT id, title FROM investigations");
      const titleMap = new Map(inv.map((i) => [i.id, i.title]));
      setRows(audioRows.map((row) => ({ ...row, investigation_title: titleMap.get(row.investigation_id) ?? null })));
    })();
  }, [reloadTick]);

  const visibleRows = useMemo(() => {
    if (!filterMineOnly || !session.current) return rows;
    return rows.filter((row) => row.investigation_id === session.current!.id);
  }, [rows, filterMineOnly, session.current]);

  const sumBytes = visibleRows.reduce((acc, row) => {
    try {
      const meta = row.metadata_json ? JSON.parse(row.metadata_json) as { bytes?: number } : null;
      return acc + (meta?.bytes ?? 0);
    } catch { return acc; }
  }, 0);

  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>EVP · Forensic audio</span>
        <h1 className={s.title}>EVP capture & editor</h1>
        <p className={s.lede}>
          Forensic-grade 16-bit / 48 kHz mono PCM. Drag on the waveform to select. Tag with reviewer Class A/B/C, save trims, export.
        </p>
      </div>

      <EvpRecorderControl investigationId={session.current?.id ?? null} onSaved={refresh} />

      <div className={r.summary}>
        <span className={r.summaryStat}><strong>{visibleRows.length}</strong> clip{visibleRows.length === 1 ? "" : "s"}</span>
        <span className={r.summaryStat}><strong>{(sumBytes / 1024 / 1024).toFixed(1)}</strong> MB</span>
        {session.current && (
          <label className={r.filter}>
            <input
              type="checkbox"
              checked={filterMineOnly}
              onChange={(e) => setFilterMineOnly(e.target.checked)}
            />
            <span>Active session only</span>
          </label>
        )}
      </div>

      {visibleRows.length === 0 ? (
        <p className={r.empty}>
          No audio clips yet.{" "}
          {session.current
            ? "Tap Start recording above to capture an EVP attempt."
            : <>Begin a session in <Link to="/">Mission Control</Link>, then come back here to record.</>}
        </p>
      ) : (
        <ol className={r.list}>
          {visibleRows.map((row) => {
            let meta: { duration_s?: number; bytes?: number; sample_rate?: number; reviewer_class?: string; source?: string } = {};
            try { meta = row.metadata_json ? JSON.parse(row.metadata_json) : {}; } catch { /* ignore */ }
            return (
              <li key={row.id} className={r.row}>
                <button type="button" className={r.rowBtn} onClick={() => setOpenAsset(row)}>
                  <div className={r.rowMain}>
                    <span className={r.rowTitle}>
                      {meta.source === "evp_trim" ? "Trim · " : ""}
                      {row.investigation_title ?? "Unfiled"}
                      {meta.reviewer_class ? <span className={r.rowClass}>Class {meta.reviewer_class.toUpperCase()}</span> : null}
                    </span>
                    <span className={r.rowMeta}>
                      {new Date(row.timestamp_start).toLocaleString()} ·
                      {" "}
                      {meta.duration_s ? `${meta.duration_s.toFixed(1)}s` : "—"} ·
                      {" "}
                      {meta.bytes ? `${(meta.bytes / 1024).toFixed(0)} KB` : "—"} ·
                      {" "}
                      {meta.sample_rate ? `${(meta.sample_rate / 1000).toFixed(0)} kHz` : "—"}
                    </span>
                    {row.checksum_sha256 && (
                      <span className={r.rowSha}>
                        sha256 {row.checksum_sha256.slice(0, 12)}…{row.checksum_sha256.slice(-8)}
                      </span>
                    )}
                  </div>
                  <span className={r.rowOpen}>Open →</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}

      {openAsset && (
        <EvpEditor
          asset={openAsset}
          onClose={() => setOpenAsset(null)}
          onSavedTrim={refresh}
        />
      )}
    </section>
  );
}
