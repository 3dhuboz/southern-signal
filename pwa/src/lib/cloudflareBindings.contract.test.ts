import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const wranglerConfig = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");

describe("Cloudflare resource bindings", () => {
  it("source-controls the production sync, media, and rate-limit bindings", () => {
    expect(wranglerConfig).toContain('"binding": "SYNC_DB"');
    expect(wranglerConfig).toContain('"database_name": "southern-signal-sync"');
    expect(wranglerConfig).toContain('"database_id": "98fa699d-b5d7-4ed5-8b64-b954a7200e89"');

    expect(wranglerConfig).toContain('"binding": "MEDIA_BUCKET"');
    expect(wranglerConfig).toContain('"bucket_name": "southern-signal-media"');

    expect(wranglerConfig).toContain('"binding": "AI_RATE_LIMIT"');
    expect(wranglerConfig).toContain('"id": "4baae3fe45cd4c4ea9181904ca599a30"');
  });

  it("source-controls isolated preview sync, media, and rate-limit bindings", () => {
    expect(wranglerConfig).toContain('"database_name": "southern-signal-sync-preview"');
    expect(wranglerConfig).toContain('"database_id": "d4b2b50f-0f8b-4f74-aa95-6085a76941a9"');

    expect(wranglerConfig).toContain('"bucket_name": "southern-signal-media-preview"');

    expect(wranglerConfig).toContain('"id": "272fcbaa91744f649842fe1a67530191"');
  });
});
