import s from "./View.module.css";

export function Review() {
  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Review</span>
        <h1 className={s.title}>Evidence</h1>
        <p className={s.lede}>Spectrograms, blind reviews, and confidence scoring will live here.</p>
      </div>
      <div className={s.panel}>
        <div className={s.panelHeading}>Coming next</div>
        <ul className={s.checklist}>
          <li>Spectrogram review with click-to-mark</li>
          <li>On-device Whisper transcript indexed to file offsets</li>
          <li>Class A / B / C EVP classification</li>
          <li>AI second-blind reviewer (opt-in cloud key)</li>
        </ul>
      </div>
    </section>
  );
}
