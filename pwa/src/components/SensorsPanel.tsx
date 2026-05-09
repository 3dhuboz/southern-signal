/**
 * SensorsPanel — discovery board for every phone sensor / platform API
 * the app can use. Live where the API is free; "needs permission" where
 * a user gesture is required; "unavailable" otherwise. The point is to
 * make the breadth of the platform visible in one glance — and to
 * surface what's missing on iOS (e.g. Magnetometer) so the operator
 * knows what gaps a Pi addon would close later.
 */

import { useSensorsDiscovery } from "../lib/sensors/sensorsDiscovery";
import s from "./SensorsPanel.module.css";

export function SensorsPanel() {
  const rows = useSensorsDiscovery();

  return (
    <section className={s.wrap} aria-label="Phone sensor inventory">
      <header className={s.head}>
        <span className={s.eyebrow}>SENSOR INVENTORY</span>
        <span className={s.note}>Phone-native APIs detected on this device.</span>
      </header>
      <ul className={s.list}>
        {rows.map((row) => (
          <li key={row.id} className={`${s.row} ${s[`state_${row.state}`]}`.trim()}>
            <span className={s.dot} aria-hidden="true" />
            <div className={s.body}>
              <span className={s.label}>{row.label}</span>
              {row.detail && <span className={s.detail}>{row.detail}</span>}
            </div>
            <span className={s.value}>{row.value || "—"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
