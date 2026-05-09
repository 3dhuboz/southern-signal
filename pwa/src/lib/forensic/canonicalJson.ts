/**
 * Canonical JSON serialisation + SHA-256 hex digest.
 *
 * These two helpers are the load-bearing primitives behind the audit chain
 * (`src/lib/db/auditLog.ts`) and the verifier embedded in exported forensic
 * bundles (`src/lib/forensic/exportBundle.ts`). If the byte-level output of
 * `canonicalJson` ever drifts, every chain ever produced by the app silently
 * un-verifies — so this module exists specifically to make the contract
 * directly testable without spinning up the DB layer.
 *
 * Contract for `canonicalJson`:
 *   - Deterministic: equivalent inputs (e.g. an object with the same keys
 *     inserted in any order) MUST produce byte-identical output.
 *   - Object keys are sorted lexicographically via `String#localeCompare` at
 *     every level of nesting. (NOTE: `localeCompare` is locale-sensitive in
 *     theory; in practice on V8/JSC with ASCII keys it matches simple
 *     codepoint order. Non-ASCII keys could in principle sort differently on
 *     different locales — we accept that for now because all keys we serialise
 *     for the audit chain are ASCII identifiers.)
 *   - Arrays preserve element order — they are NOT reordered.
 *   - Primitive serialisation (strings, numbers, booleans, null) is delegated
 *     to `JSON.stringify`, so escaping rules match standard JSON exactly.
 *   - Whitespace: none. Output is the most compact form possible.
 *
 * This is RFC 8785-ISH but not strictly compliant. Specifically, RFC 8785
 * mandates IEEE 754 number canonicalisation (e.g. `1` and `1.0` produce the
 * same output, `1e10` becomes `10000000000`); we just defer to
 * `JSON.stringify`'s number formatting. That is acceptable because the audit
 * chain only ever hashes serialised numbers as-they-came-in — we never re-
 * canonicalise a number across language boundaries.
 *
 * Do NOT change the implementation without coordinating a chain re-hash
 * migration. The verifier embedded in exported bundles has its own copy of
 * this function (see VERIFY_HTML / VERIFY_JS in exportBundle.ts) so that
 * exported bundles stay self-contained — any change here must also be
 * mirrored there.
 */
export function canonicalJson(value: unknown): string {
  // Stable stringify with sorted keys.
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * SHA-256 hex digest of a UTF-8 encoded string. Uses SubtleCrypto so there
 * is no external dependency. Output is 64 lowercase hex characters.
 *
 * Paired with `canonicalJson` to form the audit chain's per-entry hash:
 * `sha256Hex(`${seq}|${ts}|${actor}|${kind}|${canonicalJson(payload)}|${prev}`)`.
 */
export async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
