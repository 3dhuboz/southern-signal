import s from "./View.module.css";

export function Export() {
  return (
    <section className={s.view}>
      <div className={s.titleBlock}>
        <span className={s.eyebrow}>Export</span>
        <h1 className={s.title}>Evidence bundle</h1>
        <p className={s.lede}>Hash-chained, manifest-signed, locally generated.</p>
      </div>
      <div className={s.panel}>
        <div className={s.panelHeading}>Coming next</div>
        <ul className={s.checklist}>
          <li>Per-session manifest with Merkle root</li>
          <li>Hash-chained event log</li>
          <li>Plain-language client report</li>
          <li>Optional sync to Pi accessory over WiFi</li>
        </ul>
      </div>
    </section>
  );
}
