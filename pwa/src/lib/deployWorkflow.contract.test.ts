import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deployWorkflow = readFileSync(new URL("../../../.github/workflows/deploy.yml", import.meta.url), "utf8");

describe("Cloudflare Pages deploy workflow", () => {
  it("deploys master to the Pages production branch, not the main preview alias", () => {
    expect(deployWorkflow).toContain("--branch=${{ github.head_ref || github.ref_name }}");
    expect(deployWorkflow).not.toContain("github.ref_name == 'master' && 'main'");
    expect(deployWorkflow).not.toContain("--branch=main");
  });

  it("pins Wrangler 4 so wrangler.jsonc Pages bindings are honored in CI", () => {
    expect(deployWorkflow).toContain('wranglerVersion: "4.78.0"');
  });
});
