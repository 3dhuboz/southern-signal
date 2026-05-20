// @vitest-environment happy-dom

/**
 * BroadcastSceneSelector DOM-structure snapshots.
 *
 * The existing .test.tsx pins behaviour (click handler fires, aria-label
 * shape, no unicode chevron). These snapshots pin the rendered DOM tree
 * itself — class composition, SVG attributes, span nesting — so a future
 * CSS refactor or component restructure can't silently change the
 * broadcast surface without a visible diff in code review.
 *
 * CSS-module classes are normally hashed by vite (`_chip_a8b2c3`) which
 * would make these snapshots churn on every build. We stub the module
 * with an identity Proxy so `s.chip` resolves to the readable string
 * "chip" — diffs remain meaningful and the snapshot is build-independent.
 *
 * Inline snapshots (vs file snapshots) keep the structural diff visible
 * in the PR — reviewers can read what's expected without opening a
 * separate __snapshots__/ file.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Identity Proxy for the CSS module so className strings are readable
// rather than vite-hashed gibberish. Must be hoisted ahead of the import
// below — vi.mock is auto-hoisted by vitest so the declaration order
// here is fine.
vi.mock("./BroadcastSceneSelector.module.css", () => ({
  default: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { BroadcastSceneSelector } from "./BroadcastSceneSelector";

afterEach(() => {
  cleanup();
});

describe("<BroadcastSceneSelector /> DOM snapshot", () => {
  it("default eyebrow (SCENE) + Walkthrough scene name", () => {
    const { container } = render(
      <BroadcastSceneSelector sceneName="Walkthrough" onOpen={() => {}} />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <button
        aria-haspopup="dialog"
        aria-label="Scene: Walkthrough. Tap to change."
        class="chip"
        title="Change scene"
        type="button"
      >
        <span
          class="body"
        >
          <span
            class="eyebrow"
          >
            SCENE
          </span>
          <span
            class="name"
          >
            Walkthrough
          </span>
        </span>
        <svg
          aria-hidden="true"
          class="chevron"
          focusable="false"
          viewBox="0 0 12 8"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M1.5 2 L6 6 L10.5 2"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.6"
          />
        </svg>
      </button>
    `);
  });

  it("custom eyebrow (MODE) + multi-word scene name", () => {
    const { container } = render(
      <BroadcastSceneSelector sceneName="Cold Spot Sweep" eyebrow="MODE" onOpen={() => {}} />,
    );
    expect(container.firstChild).toMatchInlineSnapshot(`
      <button
        aria-haspopup="dialog"
        aria-label="Scene: Cold Spot Sweep. Tap to change."
        class="chip"
        title="Change scene"
        type="button"
      >
        <span
          class="body"
        >
          <span
            class="eyebrow"
          >
            MODE
          </span>
          <span
            class="name"
          >
            Cold Spot Sweep
          </span>
        </span>
        <svg
          aria-hidden="true"
          class="chevron"
          focusable="false"
          viewBox="0 0 12 8"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M1.5 2 L6 6 L10.5 2"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.6"
          />
        </svg>
      </button>
    `);
  });
});
