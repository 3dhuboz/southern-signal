import { useEffect, useRef } from "react";
import {
  DEFAULT_OVERLAY_LAYOUT_SETTINGS,
  OVERLAY_ANCHORS,
  OVERLAY_LAYOUT_ORIENTATIONS,
  OVERLAY_LAYOUT_TARGET_LABELS,
  type OverlayAnchor,
  type OverlayLayoutOrientation,
  type OverlayLayoutSettings,
  type OverlayLayoutTarget,
  updateOverlayOpacity,
  updateOverlayPlacement,
} from "../../lib/media/overlayLayout";
import s from "./CameraHudLayoutSheet.module.css";

const DOM_TARGETS: OverlayLayoutTarget[] = [
  "status",
  "mic",
  "scene",
  "sensors",
  "timecode",
  "lowerThird",
];

const BURN_IN_TARGETS: OverlayLayoutTarget[] = [
  "activity",
  "evp",
  "emfStack",
  "audioStack",
  "direction",
  "caption",
  "timestamp",
];

interface Props {
  open: boolean;
  settings: OverlayLayoutSettings;
  editingOrientation: OverlayLayoutOrientation;
  activeOrientation: OverlayLayoutOrientation;
  onEditingOrientationChange: (orientation: OverlayLayoutOrientation) => void;
  onSettingsChange: (settings: OverlayLayoutSettings) => void;
  onClose: () => void;
}

function AnchorButton({
  anchor,
  active,
  onClick,
}: {
  anchor: OverlayAnchor;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${s.anchorBtn} ${active ? s.anchorBtnActive : ""}`.trim()}
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Place ${anchor.replace("-", " ")}`}
      title={anchor.replace("-", " ")}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function TargetRow({
  target,
  settings,
  orientation,
  onSettingsChange,
}: {
  target: OverlayLayoutTarget;
  settings: OverlayLayoutSettings;
  orientation: OverlayLayoutOrientation;
  onSettingsChange: (settings: OverlayLayoutSettings) => void;
}) {
  const placement = settings[orientation].placements[target];

  const setAnchor = (anchor: OverlayAnchor) => {
    onSettingsChange(updateOverlayPlacement(settings, orientation, target, { anchor }));
  };

  const setOffset = (axis: "offsetX" | "offsetY", value: string) => {
    onSettingsChange(updateOverlayPlacement(settings, orientation, target, { [axis]: Number(value) }));
  };

  return (
    <div className={s.targetRow}>
      <div className={s.targetLabel}>
        <span>{OVERLAY_LAYOUT_TARGET_LABELS[target]}</span>
        <label className={s.showToggle}>
          <input
            type="checkbox"
            checked={!placement.hidden}
            onChange={(event) => {
              onSettingsChange(updateOverlayPlacement(settings, orientation, target, {
                hidden: !event.currentTarget.checked,
              }));
            }}
          />
          <span>Show</span>
        </label>
      </div>

      <div className={s.anchorGrid} aria-label={`${OVERLAY_LAYOUT_TARGET_LABELS[target]} placement`}>
        {OVERLAY_ANCHORS.map((anchor) => (
          <AnchorButton
            key={anchor}
            anchor={anchor}
            active={placement.anchor === anchor}
            onClick={() => setAnchor(anchor)}
          />
        ))}
      </div>

      <div className={s.nudges}>
        <label>
          <span>X</span>
          <input
            type="number"
            inputMode="numeric"
            value={placement.offsetX}
            onChange={(event) => setOffset("offsetX", event.currentTarget.value)}
          />
        </label>
        <label>
          <span>Y</span>
          <input
            type="number"
            inputMode="numeric"
            value={placement.offsetY}
            onChange={(event) => setOffset("offsetY", event.currentTarget.value)}
          />
        </label>
      </div>
    </div>
  );
}

export function CameraHudLayoutSheet({
  open,
  settings,
  editingOrientation,
  activeOrientation,
  onEditingOrientationChange,
  onSettingsChange,
  onClose,
}: Props) {
  const sheetRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const focusFirstControl = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = Array.from(
        sheetRef.current?.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], [tabindex]:not([tabindex='-1'])",
        ) ?? [],
      ).filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");

      if (focusable.length === 0) {
        event.preventDefault();
        sheetRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFirstControl);
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const profile = settings[editingOrientation];
  const transparencyPct = Math.round((1 - profile.opacity) * 100);

  const resetOrientation = () => {
    onSettingsChange({
      ...settings,
      [editingOrientation]: DEFAULT_OVERLAY_LAYOUT_SETTINGS[editingOrientation],
    });
  };

  return (
    <div
      className={s.backdrop}
      role="presentation"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      data-novideo-pinned
    >
      <section
        ref={sheetRef}
        className={s.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="hud-layout-title"
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={s.head}>
          <div>
            <p className={s.eyebrow}>HUD</p>
            <h2 id="hud-layout-title" className={s.title}>Display layout</h2>
          </div>
          <button ref={closeButtonRef} type="button" className={s.closeBtn} onClick={onClose} aria-label="Close HUD layout">
            <span aria-hidden="true">x</span>
          </button>
        </header>

        <div className={s.segmented} role="tablist" aria-label="Layout orientation">
          {OVERLAY_LAYOUT_ORIENTATIONS.map((orientation) => (
            <button
              key={orientation}
              type="button"
              role="tab"
              aria-selected={editingOrientation === orientation}
              className={`${s.segment} ${editingOrientation === orientation ? s.segmentActive : ""}`.trim()}
              onClick={() => onEditingOrientationChange(orientation)}
            >
              {orientation}
              {orientation === activeOrientation && <span className={s.liveDot} aria-label="current orientation" />}
            </button>
          ))}
        </div>

        <label className={s.opacityControl}>
          <span>Transparency</span>
          <input
            type="range"
            min="0"
            max="75"
            step="1"
            value={transparencyPct}
            onChange={(event) => {
              onSettingsChange(updateOverlayOpacity(
                settings,
                editingOrientation,
                1 - Number(event.currentTarget.value) / 100,
              ));
            }}
          />
          <strong>{transparencyPct}%</strong>
        </label>

        <div className={s.body}>
          <section className={s.group} aria-label="Phone HUD displays">
            <h3>Phone HUD</h3>
            {DOM_TARGETS.map((target) => (
              <TargetRow
                key={target}
                target={target}
                settings={settings}
                orientation={editingOrientation}
                onSettingsChange={onSettingsChange}
              />
            ))}
          </section>

          <section className={s.group} aria-label="Burned-in displays">
            <h3>Burn-in</h3>
            {BURN_IN_TARGETS.map((target) => (
              <TargetRow
                key={target}
                target={target}
                settings={settings}
                orientation={editingOrientation}
                onSettingsChange={onSettingsChange}
              />
            ))}
          </section>
        </div>

        <footer className={s.foot}>
          <button type="button" className={s.secondaryBtn} onClick={resetOrientation}>
            Reset {editingOrientation}
          </button>
          <button type="button" className={s.primaryBtn} onClick={onClose}>Done</button>
        </footer>
      </section>
    </div>
  );
}
