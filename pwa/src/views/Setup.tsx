import s from "./View.module.css";

export function Setup() {
  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Setup</span>
        <h1 className={s.title}>Pre-investigation</h1>
        <p className={s.lede}>Calibrate. Acknowledge Country. Pick a protocol. Run the checks.</p>
      </div>
      <div className={s.panel}>
        <div className={s.panelHeading}>Coming next</div>
        <ul className={s.checklist}>
          <li>Acknowledgement of Country gate</li>
          <li>Sensitive-site classifier (warning)</li>
          <li>Interference checklist (12 items, scored)</li>
          <li>Protocol picker + step runner</li>
          <li>Settings (cloud-AI keys, privacy, theme)</li>
        </ul>
      </div>
    </section>
  );
}
