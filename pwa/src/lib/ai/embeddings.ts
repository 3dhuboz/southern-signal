/**
 * Semantic search across investigation notes (Step 9 — scaffold).
 *
 * **Status: scaffold.** Encodes notes/transcripts into 384-d vectors using
 * `bge-small-en-v1.5` via Transformers.js, stores in sqlite-vec for k-NN
 * lookup. ~130 MB model download on first use; cached in OPFS.
 *
 * Bring-up checklist:
 *   1. `npm i @huggingface/transformers` (or `@xenova/transformers` for
 *      legacy compatibility).
 *   2. Lazy-load only when user opens semantic search — avoid 130 MB
 *      on first launch.
 *   3. Compile sqlite-vec extension into our sqlite-wasm distribution
 *      (or use the JS-side cosine-similarity fallback for V1 if vec
 *      compilation is troublesome).
 *   4. Add `embeddings` table: (id, source_table, source_id, vector_blob).
 *   5. Hook into the audit log so every text mutation triggers re-embed.
 *
 * For V1.0 we expose the type contract; the search view can render an
 * "Indexing in progress…" state until embeddings ship.
 */

export interface EmbeddingRecord {
  source_table: "evidence_events" | "transcripts" | "investigations";
  source_id: string;
  text: string;
  vector?: Float32Array; // 384-d for bge-small-en-v1.5
}

export interface SearchHit {
  source_table: string;
  source_id: string;
  text: string;
  score: number; // cosine similarity 0..1
}

export async function embedText(_text: string): Promise<Float32Array> {
  throw new Error("embeddings.embedText() is a scaffold — Transformers.js wiring lands in step 9 build.");
}

export async function searchSemantic(_query: string, _topK = 20): Promise<SearchHit[]> {
  throw new Error("embeddings.searchSemantic() is a scaffold — sqlite-vec wiring lands in step 9 build.");
}
