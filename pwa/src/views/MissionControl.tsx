import s from "./View.module.css";

export function MissionControl() {
  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Mission Control</span>
        <h1 className={s.title}>No active session</h1>
        <p className={s.lede}>
          Real phone sensors. AI-assisted review. All in one app — no Pi required.
        </p>
      </div>

      <div className={s.placeholderHero}>
        <span className={s.heroLabel}>V1 — Step 1 of 12</span>
        <div className={s.heroTitle}>Shell is live</div>
        <p className={s.heroBody}>
          You're seeing the new mobile-only PWA shell. Capture, real-tools, and AI-assisted review will land in the next steps.
        </p>
      </div>

      <div className={s.panel}>
        <div className={s.panelHeading}>What lands next</div>
        <ul className={s.checklist}>
          <li>OPFS storage + WAV streaming writer</li>
          <li>sqlite-wasm schema for cases / sessions / markers</li>
          <li>Sensor permission + capture pipeline</li>
          <li>Real EMF / vibration / ambient-light tools</li>
          <li>EVP recorder with on-device Whisper transcription</li>
        </ul>
      </div>
    </section>
  );
}
