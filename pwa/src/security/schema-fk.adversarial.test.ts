/**
 * Adversarial regression tests for the v15 FOREIGN KEY enforcement
 * (src/lib/db/schema.ts + src/lib/db/db.ts — commit f48e603).
 *
 * Threat model the fix closes:
 *
 *   The schema has carried FOREIGN KEY declarations since v3. Before
 *   v15, every connection opened against the OPFS-SAH-pool worker DID
 *   NOT issue `PRAGMA foreign_keys = ON`, which means SQLite parsed
 *   the FK clauses but never enforced them. Effects of that silent
 *   no-op:
 *
 *     1. A bug (or a malicious sync payload) could insert an
 *        evidence_event with an investigation_id that doesn't exist —
 *        an "orphan" row. Reports built off that row attribute audio
 *        to a case that was never opened.
 *
 *     2. ON DELETE CASCADE clauses were inert. Deleting an
 *        investigation row left a swathe of orphaned children in
 *        sensor_samples, evidence_events, media_assets, transcripts,
 *        etc. — referenced by reports, reachable by sync, but
 *        unattributable to any case.
 *
 *   The fix (v15): run `PRAGMA foreign_keys = ON;` BEFORE any DML on
 *   every new connection. The existing FK declarations now MEAN what
 *   they say.
 *
 * This file builds a real sqlite-wasm DB in-memory (node entrypoint),
 * applies the production SCHEMA_SQL, enables FK enforcement the same
 * way db.ts does on init, and then attempts the bypasses an attacker
 * (or a sync-bug) would try:
 *
 *   - Insert a marker (evidence_events) with a non-existent
 *     investigation_id → expect SQLITE_CONSTRAINT throw.
 *   - Insert a sensor_sample with a non-existent investigation_id →
 *     expect throw.
 *   - Insert a transcript with a non-existent media_id → expect throw.
 *   - Sanity: insert WITH a real investigation_id → succeeds (proves
 *     the rejection above isn't a false positive).
 *   - PRAGMA foreign_keys returns 1 on a fresh connection (proves the
 *     wiring runs).
 *
 * The existing schemaForeignKeys.test.ts asserts the SQL-TEXT contract
 * (SCHEMA_SQL string contains the FK lines, db.ts string contains the
 * PRAGMA). THIS file asserts the RUNTIME contract — that sqlite
 * actually rejects these inserts when the production SCHEMA_SQL +
 * PRAGMA are applied to a real database.
 */

import { beforeEach, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { CURRENT_SCHEMA_VERSION, SCHEMA_SQL } from "../lib/db/schema";

// sqlite-wasm exports a `Database` type via oo1. We type the surface we
// touch loosely — the wasm module is dynamically loaded and the
// generated typings are intentionally narrow.
interface SqliteDb {
  exec: (
    arg: string | {
      sql: string;
      bind?: unknown[];
      rowMode?: "array" | "object";
      returnValue?: "this" | "resultRows";
      resultRows?: unknown[];
    },
  ) => unknown;
  selectValue: (sql: string, bind?: unknown[]) => unknown;
  selectObject: (sql: string, bind?: unknown[]) => Record<string, unknown> | undefined;
  close: () => void;
}

interface Sqlite3Module {
  oo1: {
    DB: new (filename: string, mode: string) => SqliteDb;
  };
}

let sqlite3: Sqlite3Module | null = null;

async function getSqlite(): Promise<Sqlite3Module> {
  if (!sqlite3) {
    // sqlite3InitModule with no args loads the JS-only wasm bundle. We
    // never touch OPFS here — :memory: only.
    sqlite3 = (await sqlite3InitModule()) as unknown as Sqlite3Module;
  }
  return sqlite3;
}

/**
 * Build a fresh DB the same way the production db.ts init() does:
 *
 *   1. Apply SCHEMA_SQL (idempotent CREATE IF NOT EXISTS).
 *   2. Enable PRAGMA foreign_keys = ON.
 *   3. Apply the legacy ALTER columns from db.ts so any test that
 *      INSERTs a row touching those columns lines up with prod.
 *
 * The v15-equivalent enabling of FK enforcement is the load-bearing
 * step — without it, every "expect throw" below would silently pass
 * an insert and the test would go red (which is what we want, because
 * the production code IS supposed to enable FKs).
 */
async function buildFreshDb(): Promise<SqliteDb> {
  const s = await getSqlite();
  const db = new s.oo1.DB(":memory:", "ct");
  // CRITICAL: enable FK enforcement BEFORE any DML — matches db.ts:126.
  // SQLite forbids toggling PRAGMA foreign_keys mid-transaction, so this
  // must come before SCHEMA_SQL.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA_SQL);
  // Mirror the legacy ALTER columns the production init runs against
  // older DBs. On a fresh DB these are no-ops (column added or already
  // exists in SCHEMA_SQL) — we swallow errors the same way db.ts does.
  for (const col of [
    "ALTER TABLE investigations ADD COLUMN culturally_sensitive INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE investigations ADD COLUMN protocol_json TEXT",
    "ALTER TABLE investigations ADD COLUMN protocol_hash TEXT",
    "ALTER TABLE investigations ADD COLUMN session_type TEXT NOT NULL DEFAULT 'active'",
    "ALTER TABLE investigations ADD COLUMN paired_investigation_id TEXT",
    "ALTER TABLE bundle_signatures RENAME COLUMN ed25519_pubkey_b64 TO ed25519_pubkey_hex",
    "ALTER TABLE media_assets    ADD COLUMN restriction       TEXT    NOT NULL DEFAULT 'open'",
    "ALTER TABLE evidence_events ADD COLUMN restriction       TEXT    NOT NULL DEFAULT 'open'",
    "ALTER TABLE investigations  ADD COLUMN to_consent_path  TEXT",
    "ALTER TABLE investigations  ADD COLUMN commercial_use_approved INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { db.exec(col); } catch { /* column already exists — fine */ }
  }
  return db;
}

function insertInvestigation(db: SqliteDb, id: string, title: string): void {
  db.exec({
    sql: "INSERT INTO investigations (id, title, created_at) VALUES (?, ?, ?)",
    bind: [id, title, "2026-05-19T00:00:00.000Z"],
  });
}

function insertMedia(db: SqliteDb, opts: {
  id: string; investigationId: string; filePath?: string; mediaType?: string;
}): void {
  db.exec({
    sql: `INSERT INTO media_assets (id, investigation_id, media_type, file_path, timestamp_start)
          VALUES (?, ?, ?, ?, ?)`,
    bind: [
      opts.id,
      opts.investigationId,
      opts.mediaType ?? "audio",
      opts.filePath ?? "media/clip.wav",
      "2026-05-19T00:00:00.000Z",
    ],
  });
}

// ---------------------------------------------------------------------------
// 1. PRAGMA wiring — assert FK enforcement is actually ON.
// ---------------------------------------------------------------------------

describe("v15 — PRAGMA foreign_keys is ON on a fresh connection", () => {
  it("buildFreshDb leaves foreign_keys = 1 (load-bearing for every test below)", async () => {
    const db = await buildFreshDb();
    try {
      const fkState = db.selectValue("PRAGMA foreign_keys");
      // sqlite-wasm returns 1 or 1n depending on integer mode.
      expect(Number(fkState)).toBe(1);
    } finally {
      db.close();
    }
  });

  it("CURRENT_SCHEMA_VERSION is >= 15 so on-disk DBs upgrade", async () => {
    // Mirrors the contract from schemaForeignKeys.test.ts — pinned here
    // so this file is self-contained if that one is ever refactored.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// 2. evidence_events FK enforcement — markers can't reference a phantom case.
// ---------------------------------------------------------------------------

describe("v15 — evidence_events.investigation_id FK is enforced", () => {
  let db: SqliteDb;
  beforeEach(async () => { db = await buildFreshDb(); });

  it("REJECTS a marker insert pointing at an investigation that doesn't exist", async () => {
    // No row in investigations table. Attempt to insert a marker
    // claiming investigation_id = "ghost-case". SQLite must throw a
    // FOREIGN KEY constraint violation.
    let threw: unknown = null;
    try {
      db.exec({
        sql: `INSERT INTO evidence_events
              (id, investigation_id, timestamp, source, event_type, title)
              VALUES (?, ?, ?, ?, ?, ?)`,
        bind: [
          "ev-1",
          "ghost-case",
          "2026-05-19T00:00:00.000Z",
          "user",
          "marker",
          "Cold spot",
        ],
      });
    } catch (e) { threw = e; }
    try {
      expect(threw).not.toBeNull();
      expect((threw as Error).message.toLowerCase()).toMatch(/foreign key/);
      // No row should have been written.
      const count = db.selectValue("SELECT COUNT(*) FROM evidence_events");
      expect(Number(count)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("REJECTS a marker insert with an investigation_id that was just deleted (orphan-creation race)", async () => {
    insertInvestigation(db, "inv-1", "Old House");
    db.exec({ sql: "DELETE FROM investigations WHERE id = ?", bind: ["inv-1"] });
    let threw: unknown = null;
    try {
      db.exec({
        sql: `INSERT INTO evidence_events
              (id, investigation_id, timestamp, source, event_type, title)
              VALUES (?, ?, ?, ?, ?, ?)`,
        bind: ["ev-orphan", "inv-1", "2026-05-19T00:00:00.000Z", "user", "marker", "Late marker"],
      });
    } catch (e) { threw = e; }
    try {
      expect(threw).not.toBeNull();
      expect((threw as Error).message.toLowerCase()).toMatch(/foreign key/);
    } finally {
      db.close();
    }
  });

  it("SANITY: inserts succeed when investigation_id refers to a real row (proves rejection isn't a false positive)", async () => {
    insertInvestigation(db, "inv-1", "Old House");
    try {
      db.exec({
        sql: `INSERT INTO evidence_events
              (id, investigation_id, timestamp, source, event_type, title)
              VALUES (?, ?, ?, ?, ?, ?)`,
        bind: ["ev-1", "inv-1", "2026-05-19T00:00:00.000Z", "user", "marker", "Real marker"],
      });
      const count = db.selectValue("SELECT COUNT(*) FROM evidence_events WHERE id = ?", ["ev-1"]);
      expect(Number(count)).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. sensor_samples FK enforcement — telemetry can't attach to a phantom case.
// ---------------------------------------------------------------------------

describe("v15 — sensor_samples.investigation_id FK is enforced", () => {
  let db: SqliteDb;
  beforeEach(async () => { db = await buildFreshDb(); });

  it("REJECTS a sensor sample insert pointing at a non-existent investigation", async () => {
    // Telemetry orphans were the most numerous orphan-row class in the
    // pre-v15 DB inspection (sensor_samples accumulate at ~1Hz).
    let threw: unknown = null;
    try {
      db.exec({
        sql: `INSERT INTO sensor_samples
              (id, investigation_id, timestamp, sensor_type, value)
              VALUES (?, ?, ?, ?, ?)`,
        bind: ["s-1", "ghost-case", "2026-05-19T00:00:00.000Z", "emf", 1.234],
      });
    } catch (e) { threw = e; }
    try {
      expect(threw).not.toBeNull();
      expect((threw as Error).message.toLowerCase()).toMatch(/foreign key/);
      const count = db.selectValue("SELECT COUNT(*) FROM sensor_samples");
      expect(Number(count)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("SANITY: sensor samples insert against a real investigation succeed", async () => {
    insertInvestigation(db, "inv-1", "Site A");
    try {
      db.exec({
        sql: `INSERT INTO sensor_samples
              (id, investigation_id, timestamp, sensor_type, value)
              VALUES (?, ?, ?, ?, ?)`,
        bind: ["s-1", "inv-1", "2026-05-19T00:00:00.000Z", "emf", 0.5],
      });
      const count = db.selectValue("SELECT COUNT(*) FROM sensor_samples WHERE id = ?", ["s-1"]);
      expect(Number(count)).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. transcripts FK enforcement — segment can't attach to phantom media.
// ---------------------------------------------------------------------------

describe("v15 — transcripts.media_id and investigation_id FKs are enforced", () => {
  let db: SqliteDb;
  beforeEach(async () => { db = await buildFreshDb(); });

  it("REJECTS a transcript insert pointing at a non-existent media_id", async () => {
    // The investigation_id is valid; only media_id is the phantom. A
    // naive bug that only checked the investigation FK would miss this.
    insertInvestigation(db, "inv-1", "Site A");
    let threw: unknown = null;
    try {
      db.exec({
        sql: `INSERT INTO transcripts
              (id, media_id, investigation_id, segment_start_s, segment_end_s, text, engine)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: ["t-1", "ghost-media", "inv-1", 0, 1, "hello", "whisper-base.en"],
      });
    } catch (e) { threw = e; }
    try {
      expect(threw).not.toBeNull();
      expect((threw as Error).message.toLowerCase()).toMatch(/foreign key/);
      const count = db.selectValue("SELECT COUNT(*) FROM transcripts");
      expect(Number(count)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("REJECTS a transcript insert with valid media_id but a non-existent investigation_id (defence in depth)", async () => {
    insertInvestigation(db, "inv-1", "Site A");
    insertMedia(db, { id: "m-1", investigationId: "inv-1" });
    let threw: unknown = null;
    try {
      db.exec({
        sql: `INSERT INTO transcripts
              (id, media_id, investigation_id, segment_start_s, segment_end_s, text, engine)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: ["t-1", "m-1", "ghost-case", 0, 1, "hello", "whisper-base.en"],
      });
    } catch (e) { threw = e; }
    try {
      expect(threw).not.toBeNull();
      expect((threw as Error).message.toLowerCase()).toMatch(/foreign key/);
    } finally {
      db.close();
    }
  });

  it("SANITY: a transcript with valid media_id AND investigation_id succeeds", async () => {
    insertInvestigation(db, "inv-1", "Site A");
    insertMedia(db, { id: "m-1", investigationId: "inv-1" });
    try {
      db.exec({
        sql: `INSERT INTO transcripts
              (id, media_id, investigation_id, segment_start_s, segment_end_s, text, engine)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: ["t-1", "m-1", "inv-1", 0, 1.5, "what's your name", "whisper-base.en"],
      });
      const count = db.selectValue("SELECT COUNT(*) FROM transcripts WHERE id = ?", ["t-1"]);
      expect(Number(count)).toBe(1);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. ON DELETE CASCADE — child rows go when parent goes (FKs ON makes this real).
// ---------------------------------------------------------------------------

describe("v15 — ON DELETE CASCADE actually fires now (was inert before v15)", () => {
  it("deleting an investigation cascades into evidence_events + sensor_samples + media_assets", async () => {
    const db = await buildFreshDb();
    try {
      insertInvestigation(db, "inv-1", "Site A");
      // Insert one child in each of three tables that have ON DELETE CASCADE.
      db.exec({
        sql: `INSERT INTO evidence_events
              (id, investigation_id, timestamp, source, event_type, title)
              VALUES (?, ?, ?, ?, ?, ?)`,
        bind: ["ev-1", "inv-1", "2026-05-19T00:00:00.000Z", "user", "marker", "x"],
      });
      db.exec({
        sql: `INSERT INTO sensor_samples
              (id, investigation_id, timestamp, sensor_type, value)
              VALUES (?, ?, ?, ?, ?)`,
        bind: ["s-1", "inv-1", "2026-05-19T00:00:00.000Z", "emf", 1.0],
      });
      insertMedia(db, { id: "m-1", investigationId: "inv-1" });

      // Three children alive.
      expect(Number(db.selectValue("SELECT COUNT(*) FROM evidence_events"))).toBe(1);
      expect(Number(db.selectValue("SELECT COUNT(*) FROM sensor_samples"))).toBe(1);
      expect(Number(db.selectValue("SELECT COUNT(*) FROM media_assets"))).toBe(1);

      // Delete the parent.
      db.exec({ sql: "DELETE FROM investigations WHERE id = ?", bind: ["inv-1"] });

      // All three children gone (proves CASCADE actually fires).
      expect(Number(db.selectValue("SELECT COUNT(*) FROM evidence_events"))).toBe(0);
      expect(Number(db.selectValue("SELECT COUNT(*) FROM sensor_samples"))).toBe(0);
      expect(Number(db.selectValue("SELECT COUNT(*) FROM media_assets"))).toBe(0);
    } finally {
      db.close();
    }
  });

  it("research_dossiers uses ON DELETE SET NULL — investigation_id is nulled, dossier survives", async () => {
    // Pinned because research dossiers are valid as standalone recon
    // (no investigation yet), so the FK is ON DELETE SET NULL not CASCADE.
    // If a future refactor accidentally changes it to CASCADE, this test
    // fails and the operator's pre-visit dossiers would silently vanish
    // when the case they retroactively got attached to is deleted.
    const db = await buildFreshDb();
    try {
      insertInvestigation(db, "inv-1", "Site A");
      db.exec({
        sql: `INSERT INTO research_dossiers
              (id, investigation_id, venue_name, region, created_at, model, result_json)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: ["d-1", "inv-1", "Old Court", "AU", "2026-05-19T00:00:00.000Z", "test", "{}"],
      });
      expect(Number(db.selectValue("SELECT COUNT(*) FROM research_dossiers"))).toBe(1);
      db.exec({ sql: "DELETE FROM investigations WHERE id = ?", bind: ["inv-1"] });
      // Dossier survives.
      expect(Number(db.selectValue("SELECT COUNT(*) FROM research_dossiers"))).toBe(1);
      // investigation_id is now NULL.
      const dossier = db.selectObject("SELECT * FROM research_dossiers WHERE id = ?", ["d-1"]);
      expect(dossier?.investigation_id).toBeNull();
    } finally {
      db.close();
    }
  });
});
