import { describe, expect, it } from "vitest";
import {
  createCalibrationState,
  isInstrumentTrustworthy,
  recordAttempt,
  startCalibration,
  summary,
} from "./calibration";

describe("calibration state machine", () => {
  it("starts idle and not trustworthy", () => {
    const s = createCalibrationState();
    expect(s.status).toBe("idle");
    expect(isInstrumentTrustworthy(s)).toBe(false);
  });

  it("passes after 3 correct sectors in a row", () => {
    let s = startCalibration(createCalibrationState());
    s = recordAttempt(s, { measured: "FRONT-R", coherence: 0.9, itdMs: 0.4, ts: 1 });
    s = recordAttempt(s, { measured: "REAR-C", coherence: 0.85, itdMs: 0, ts: 2 });
    s = recordAttempt(s, { measured: "FRONT-L", coherence: 0.92, itdMs: -0.4, ts: 3 });
    expect(s.status).toBe("passed");
    expect(isInstrumentTrustworthy(s)).toBe(true);
    expect(summary(s)).toContain("PASS 3/3");
  });

  it("degrades on first failure", () => {
    let s = startCalibration(createCalibrationState());
    s = recordAttempt(s, { measured: "FRONT-R", coherence: 0.9, itdMs: 0.4, ts: 1 });
    s = recordAttempt(s, { measured: "FRONT-L", coherence: 0.85, itdMs: -0.4, ts: 2 }); // expected REAR-C, got FRONT-L
    expect(s.status).toBe("degraded");
    expect(isInstrumentTrustworthy(s)).toBe(false);
    expect(summary(s)).toContain("DEGRADED");
  });

  it("ignores attempts after settled", () => {
    let s = startCalibration(createCalibrationState());
    s = recordAttempt(s, { measured: "FRONT-R", coherence: 0.9, itdMs: 0.4, ts: 1 });
    s = recordAttempt(s, { measured: "REAR-C", coherence: 0.85, itdMs: 0, ts: 2 });
    s = recordAttempt(s, { measured: "FRONT-L", coherence: 0.92, itdMs: -0.4, ts: 3 });
    const after = recordAttempt(s, { measured: "FRONT-R", coherence: 0.9, itdMs: 0.4, ts: 4 });
    expect(after).toBe(s); // no change once passed
  });
});
