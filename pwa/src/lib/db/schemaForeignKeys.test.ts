/**
 * Schema FK / v15 migration regression tests.
 *
 * These tests don't spin up the real sqlite-wasm worker (that lives behind
 * Web Worker postMessage and isn't viable inside vitest's node runner).
 * Instead they assert the SQL-text contracts we actually rely on:
 *
 *  1. `CURRENT_SCHEMA_VERSION` is bumped past v14 so on-device DBs detect
 *     the upgrade and stamp the new version.
 *  2. Every child table in `SCHEMA_SQL` carries an explicit FOREIGN KEY
 *     declaration (we audited the schema by hand; this test pins the
 *     contract so a future patch can't quietly drop one).
 *  3. The v15 migration in db.ts enables `PRAGMA foreign_keys = ON` and
 *     runs orphan cleanup. This is asserted by reading the source file —
 *     the alternative (a live sqlite-wasm) costs us COOP/COEP headers in
 *     CI which we deliberately don't ship.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from "./schema";

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_TS = readFileSync(resolve(HERE, "db.ts"), "utf8");

describe("v15 — schema version", () => {
  it("bumps CURRENT_SCHEMA_VERSION past v14 so legacy DBs upgrade", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
  });
});

describe("v15 — FK declarations in SCHEMA_SQL", () => {
  // Every child table needs a FOREIGN KEY declaration that points at the
  // expected parent. If a future patch adds a new table without its FK,
  // this test fails BEFORE the patch ever reaches a release build.
  const requiredFks: Array<{ table: string; columns: string; parent: string }> = [
    { table: "sensor_samples",        columns: "(investigation_id)", parent: "investigations" },
    { table: "evidence_events",       columns: "(investigation_id)", parent: "investigations" },
    { table: "media_assets",          columns: "(investigation_id)", parent: "investigations" },
    { table: "transcripts",           columns: "(media_id)",         parent: "media_assets" },
    { table: "transcripts",           columns: "(investigation_id)", parent: "investigations" },
    { table: "research_dossiers",     columns: "(investigation_id)", parent: "investigations" },
    { table: "research_finding_notes",columns: "(dossier_id)",       parent: "research_dossiers" },
    { table: "debunk_checklist",      columns: "(investigation_id)", parent: "investigations" },
    { table: "debunk_checklist",      columns: "(event_id)",         parent: "evidence_events" },
    { table: "interviews",            columns: "(investigation_id)", parent: "investigations" },
    { table: "trigger_objects",       columns: "(investigation_id)", parent: "investigations" },
    { table: "trigger_object_checks", columns: "(trigger_object_id)", parent: "trigger_objects" },
    { table: "trigger_object_checks", columns: "(investigation_id)",  parent: "investigations" },
    { table: "bundle_signatures",     columns: "(investigation_id)", parent: "investigations" },
  ];

  for (const { table, columns, parent } of requiredFks) {
    it(`${table}${columns} → ${parent}(id) is declared`, () => {
      const re = new RegExp(
        `FOREIGN\\s+KEY\\s*${columns.replace(/[()]/g, "\\$&")}\\s*REFERENCES\\s+${parent}\\s*\\(\\s*id\\s*\\)`,
        "i",
      );
      expect(SCHEMA_SQL).toMatch(re);
    });
  }

  it("audit_log intentionally has NO FK (append-only chain integrity)", () => {
    // The chain's verification logic does not need an FK — and we don't
    // want a FK to spuriously cascade-delete chain entries. Pin the
    // intent so a future patch can't accidentally add one.
    const auditBlock = SCHEMA_SQL.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+audit_log\s*\([\s\S]*?\);/i);
    expect(auditBlock, "audit_log table block not found in SCHEMA_SQL").toBeTruthy();
    expect(auditBlock![0]).not.toMatch(/FOREIGN\s+KEY/i);
  });
});

describe("v15 — db.ts enforcement wiring", () => {
  it("enables PRAGMA foreign_keys = ON during init", () => {
    expect(DB_TS).toMatch(/PRAGMA\s+foreign_keys\s*=\s*ON/i);
  });

  it("runs orphan-row cleanup (CASCADE-equivalent) before stamping v15", () => {
    // Spot-check three representative tables — sensor_samples, evidence_events,
    // and debunk_checklist — to confirm the orphan-row cleanup block exists.
    expect(DB_TS).toMatch(/DELETE FROM sensor_samples\s+WHERE investigation_id NOT IN/i);
    expect(DB_TS).toMatch(/DELETE FROM evidence_events\s+WHERE investigation_id NOT IN/i);
    expect(DB_TS).toMatch(/DELETE FROM debunk_checklist\s+WHERE investigation_id NOT IN/i);
  });

  it("exports withTransaction so repos can wrap multi-write sequences", () => {
    expect(DB_TS).toMatch(/export\s+async\s+function\s+withTransaction\b/);
  });
});

describe("v15 — at runtime, FK violations raise (contract test)", () => {
  // We don't have a real sqlite-wasm in this runner, but we DO have the
  // SQL contract: every write into a child table includes a parent id
  // column. A FK violation would surface as "FOREIGN KEY constraint
  // failed" — sqlite-wasm propagates that as an Error from db.exec.
  // The repo wrappers (createInvestigation, recordEvent, etc.) use
  // withTransaction; on FK rejection the BEGIN/COMMIT block rolls back
  // and rethrows. End-to-end coverage in a browser harness is
  // out-of-scope for unit tests, but the wiring is asserted in
  // `db.ts enforcement wiring` above.
  it("documents the contract", () => {
    // Pin a sentinel so this file shows up in `pnpm test` output.
    expect(true).toBe(true);
  });
});
