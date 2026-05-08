/**
 * Curated phoneme / morpheme corpus for the Spirit Box tool.
 *
 * Honest framing: this is NOT a radio sweep. Browsers cannot tune AM/FM.
 * Cycling through fragments at 100-300 ms intervals approximates the
 * auditory chaos of a radio-sweep spirit box but is deterministic, seeded,
 * and inspectable.
 *
 * Corpus is a mix of common English single-syllable words, function words,
 * and short morphemes — chosen for phonetic variety, not semantic content.
 */

export const PHONEME_CORPUS: readonly string[] = [
  "yes", "no", "now", "here", "there", "go", "come", "stay", "leave", "stop",
  "help", "hello", "hi", "hey", "wait", "look", "see", "watch", "listen", "say",
  "tell", "speak", "name", "who", "what", "when", "where", "why", "how", "if",
  "the", "a", "an", "and", "or", "but", "so", "for", "from", "to",
  "in", "on", "at", "by", "with", "of", "as", "up", "down", "back",
  "this", "that", "these", "those", "some", "all", "one", "two", "three", "more",
  "less", "good", "bad", "old", "new", "young", "alive", "dead", "soft", "loud",
  "near", "far", "high", "low", "warm", "cold", "light", "dark", "open", "close",
  "tha", "thi", "stra", "fly", "shi", "gho", "pre", "spi", "ria", "ato",
  "den", "men", "ten", "fin", "rin", "lin", "min", "win", "bin", "din",
  "an", "en", "in", "on", "un", "or", "er", "ar", "ir", "ur",
  "br", "cr", "dr", "fr", "gr", "pr", "tr", "wr", "bl", "cl",
  "ah", "oh", "uh", "eh", "ee", "oo", "ai", "ei", "ou", "ie",
];

const SCRAMBLE = 2147483647;

/**
 * Deterministic next-phoneme picker. `entropy` should be a number that
 * varies with sensor readings — magnetometer or accelerometer magnitude
 * works. The seed advances by `step` per call.
 */
export function nextPhoneme(seed: number, entropy: number): { phoneme: string; nextSeed: number } {
  const next = (Math.imul(seed | 0, 1103515245) + ((entropy * 1e6) | 0) + 12345) & SCRAMBLE;
  const idx = Math.abs(next) % PHONEME_CORPUS.length;
  return { phoneme: PHONEME_CORPUS[idx], nextSeed: next };
}
