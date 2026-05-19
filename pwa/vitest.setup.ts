// Vitest setup — runs once per worker before any test imports.
//
// Only effect: pull in jest-dom's matchers (toBeInTheDocument, toHaveAttribute,
// toHaveClass, etc.) and register them onto Vitest's expect. The import has a
// side-effect that mutates the global expect, which is why a separate setup
// file (not a per-test import) is the right home for it.
//
// happy-dom is the configured environment for *.test.tsx via vitest.config.ts;
// node-env tests skip this setup entirely because they never read the matchers.
import "@testing-library/jest-dom/vitest";
