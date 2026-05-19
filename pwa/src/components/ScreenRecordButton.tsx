/**
 * Screen-record button for the Mission Control hero.
 *
 * On Android Chrome: tap → getDisplayMedia → MediaRecorder → save WebM.
 * On iOS PWAs: shows a tip dialog directing the user to Control Center
 * → Screen Record (the native iOS feature). Either way, we hash-chain
 * recording.start / recording.stop into the audit log so the recording
 * can be timestamp-aligned with the session even when iOS does the
 * actual capture out-of-app.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { appendAuditEntry } from "../lib/db/auditLog";
import { ScreenRecorder, downloadRecording, isInAppRecordingSupported, type RecorderState } from "../lib/recording/screenRecorder";
import { useFocusTrap } from "../hooks/useFocusTrap";
import s from "./ScreenRecordButton.module.css";

interface ScreenRecordButtonProps {
  investigationId: string | null;
  /**
   * When provided, renders as a compact icon+label tile (e.g. in the
   * camera dock) using the caller's CSS Module classes. The dot indicator
   * is suppressed; a monitor icon is shown instead. Without this prop the
   * component renders as its default pill button.
   */
  classNames?: {
    /** Button class when idle. */
    idle: string;
    /** Button class when recording or saving. */
    active: string;
    /** Wrapper class for the icon span. */
    icon: string;
    /** Class for the label span. */
    label: string;
  };
}

function formatMs(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const m = Math.floor(t / 60).toString().padStart(2, "0");
  const sec = (t % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

function IconScreenRec() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none">
      {/* Monitor frame */}
      <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      {/* Stand */}
      <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {/* Recording dot — top-right corner of screen */}
      <circle cx="17" cy="7" r="2.2" fill="currentColor" />
    </svg>
  );
}

export function ScreenRecordButton({ investigationId, classNames }: ScreenRecordButtonProps) {
  const recorderRef = useRef<ScreenRecorder | null>(null);
  const [state, setState] = useState<RecorderState>(() => ({
    status: "idle",
    startedAt: null,
    durationSeconds: 0,
    error: null,
    inAppRecordingUnavailable: !isInAppRecordingSupported(),
  }));
  const [showIosTip, setShowIosTip] = useState(false);
  const inAppOk = !state.inAppRecordingUnavailable;
  // a11y: trap focus inside the iOS tip dialog while it's open. Escape
  // dismisses without logging stop — same as the Cancel button.
  const iosTipTrapRef = useFocusTrap<HTMLDivElement>(showIosTip, {
    onEscape: () => setShowIosTip(false),
  });

  useEffect(() => {
    const recorder = new ScreenRecorder();
    recorderRef.current = recorder;
    const unsubscribe = recorder.subscribe((next) => setState(next));
    return () => {
      unsubscribe();
      void recorder.stop();
    };
  }, []);

  const handleStart = useCallback(async () => {
    // Always log the start moment so iOS-native recordings can be aligned by timestamp.
    await appendAuditEntry({
      actor: "user",
      kind: "recording.start",
      payload: {
        investigation_id: investigationId,
        method: inAppOk ? "in-app" : "ios-control-center",
      },
    });
    if (!inAppOk) {
      setShowIosTip(true);
      return;
    }
    await recorderRef.current?.start();
  }, [investigationId, inAppOk]);

  const handleStop = useCallback(async () => {
    if (!inAppOk) {
      // Just log the stop and dismiss the tip — the actual recording is iOS-native.
      await appendAuditEntry({
        actor: "user",
        kind: "recording.stop",
        payload: { investigation_id: investigationId, method: "ios-control-center" },
      });
      setShowIosTip(false);
      return;
    }
    const result = await recorderRef.current?.stop();
    await appendAuditEntry({
      actor: "user",
      kind: "recording.stop",
      payload: {
        investigation_id: investigationId,
        method: "in-app",
        size_bytes: result?.sizeBytes ?? 0,
        duration_seconds: result?.durationSeconds ?? 0,
        mime: result?.mimeType ?? null,
      },
    });
    if (result) downloadRecording(result);
  }, [investigationId, inAppOk]);

  const recording = state.status === "recording" || state.status === "saving" || showIosTip;

  return (
    <>
      {classNames ? (
        /* Compact dock-tile mode — icon above label, visual driven by caller's CSS. */
        <button
          type="button"
          className={recording ? classNames.active : classNames.idle}
          onClick={recording ? handleStop : handleStart}
          aria-pressed={recording}
          aria-label={recording ? "Stop screen recording" : "Screen record"}
          title={recording ? "Stop screen recording" : "Screen record (raw device pixels)"}
        >
          <span className={classNames.icon} aria-hidden="true"><IconScreenRec /></span>
          <span className={classNames.label}>
            {state.status === "saving" ? "Save" : recording ? formatMs(state.durationSeconds) : "SCR"}
          </span>
        </button>
      ) : (
        /* Default pill mode. */
        <button
          type="button"
          className={recording ? s.btnRec : s.btn}
          onClick={recording ? handleStop : handleStart}
          aria-label={recording ? "Stop recording" : "Start screen recording"}
        >
          <span className={recording ? s.dotRec : s.dot} aria-hidden="true" />
          <span className={s.label}>
            {state.status === "saving"
              ? "Saving…"
              : recording
                ? `REC ${formatMs(state.durationSeconds)}`
                : "Record screen"}
          </span>
        </button>
      )}
      {state.error && <p className={s.error}>{state.error}</p>}

      {showIosTip && (
        <div className={s.tipOverlay} role="dialog" aria-modal="true" aria-labelledby="screen-rec-ios-tip-title" ref={iosTipTrapRef} tabIndex={-1}>
          <div className={s.tipPanel}>
            <h3 id="screen-rec-ios-tip-title" className={s.tipTitle}>Use iOS Screen Record</h3>
            <p className={s.tipBody}>
              In-app screen capture isn't reliable on iPhone. Use the native recorder instead:
            </p>
            <ol className={s.tipSteps}>
              <li>Swipe down from the top-right to open <strong>Control Center</strong>.</li>
              <li>Tap the <strong>Record</strong> button (a circle inside a circle).</li>
              <li>Wait for the 3-second countdown, then come back here.</li>
              <li>Stop the recording from Control Center when you're done — it lands in <strong>Photos</strong>.</li>
            </ol>
            <p className={s.tipFootnote}>
              The audit chain has logged the start/stop timestamps so we can align the iOS recording with the session timeline.
            </p>
            <div className={s.tipActions}>
              <button type="button" className={s.tipDone} onClick={handleStop}>
                Got it — log stop now
              </button>
              <button type="button" className={s.tipCancel} onClick={() => setShowIosTip(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
