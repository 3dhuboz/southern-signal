/**
 * Curated word dictionary for the Ovilus-style tool.
 *
 * Honest framing: this is NOT magic. The word selection is seeded by
 * magnetometer (Android) or compass-heading entropy (iOS). The mapping
 * is deterministic and inspectable. Investigators decide what (if any)
 * meaning to attach to outputs.
 *
 * Dictionary sourced from common-meaning English words to maximise
 * recognisable hits. ~520 words. Editable in V1.1 (Settings).
 */

export const OVILUS_DICTIONARY: readonly string[] = [
  "yes", "no", "maybe", "now", "here", "there", "go", "stay", "leave", "stop",
  "help", "hello", "hi", "hey", "wait", "look", "see", "watch", "listen", "say",
  "tell", "speak", "name", "who", "what", "when", "where", "why", "how", "if",
  "i", "you", "we", "they", "he", "she", "it", "us", "them", "me",
  "alone", "together", "with", "without", "near", "far", "behind", "front", "above", "below",
  "inside", "outside", "open", "closed", "door", "window", "wall", "floor", "ceiling", "stair",
  "house", "home", "room", "kitchen", "bedroom", "bathroom", "hallway", "attic", "basement", "garden",
  "old", "new", "ancient", "modern", "young", "elder", "child", "boy", "girl", "man",
  "woman", "father", "mother", "son", "daughter", "sister", "brother", "uncle", "aunt", "grandmother",
  "grandfather", "family", "friend", "stranger", "lost", "found", "remember", "forget", "know", "learn",
  "love", "hate", "fear", "joy", "sadness", "anger", "peace", "calm", "panic", "trust",
  "alive", "dead", "spirit", "soul", "body", "mind", "heart", "voice", "breath", "shadow",
  "light", "dark", "bright", "dim", "shine", "burn", "candle", "lamp", "torch", "fire",
  "water", "earth", "air", "wind", "rain", "snow", "ice", "river", "ocean", "sea",
  "tree", "flower", "grass", "leaf", "branch", "root", "forest", "field", "garden", "park",
  "morning", "noon", "evening", "night", "midnight", "dawn", "dusk", "today", "yesterday", "tomorrow",
  "always", "never", "often", "sometimes", "rarely", "soon", "later", "now", "before", "after",
  "year", "month", "week", "day", "hour", "minute", "moment", "instant", "forever", "eternal",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "first", "second", "third", "last", "next", "previous", "many", "few", "all", "none",
  "good", "bad", "right", "wrong", "true", "false", "real", "fake", "honest", "dishonest",
  "happy", "sad", "angry", "afraid", "brave", "kind", "cruel", "gentle", "rough", "soft",
  "loud", "quiet", "silent", "noise", "music", "song", "voice", "whisper", "scream", "cry",
  "laugh", "smile", "frown", "sigh", "breathe", "rest", "sleep", "wake", "dream", "wake",
  "walk", "run", "jump", "climb", "fall", "rise", "stand", "sit", "lie", "dance",
  "eat", "drink", "taste", "smell", "touch", "feel", "hear", "see", "look", "watch",
  "find", "lose", "give", "take", "send", "receive", "open", "close", "begin", "end",
  "start", "stop", "go", "come", "arrive", "depart", "stay", "leave", "return", "remain",
  "love", "hate", "like", "dislike", "want", "need", "have", "miss", "remember", "forget",
  "think", "believe", "doubt", "wonder", "ask", "answer", "tell", "say", "speak", "talk",
  "build", "break", "fix", "destroy", "create", "make", "find", "lose", "win", "fail",
  "live", "die", "born", "young", "old", "grow", "die", "stay", "leave", "rest",
  "warm", "cold", "hot", "cool", "freezing", "burning", "comfortable", "tired", "energetic", "slow",
  "fast", "swift", "quick", "still", "moving", "alive", "dead", "active", "passive", "calm",
  "blue", "red", "green", "yellow", "white", "black", "gray", "brown", "purple", "pink",
  "circle", "square", "triangle", "line", "dot", "point", "shape", "form", "edge", "corner",
  "stone", "rock", "wood", "metal", "glass", "paper", "cloth", "leather", "plastic", "clay",
  "knife", "key", "lock", "chain", "rope", "wire", "string", "thread", "fabric", "cloth",
  "book", "letter", "word", "story", "tale", "history", "memory", "secret", "truth", "lie",
  "cross", "circle", "star", "heart", "eye", "hand", "foot", "head", "face", "body",
  "ghost", "spirit", "demon", "angel", "saint", "monk", "priest", "witch", "shaman", "elder",
  "ritual", "prayer", "song", "chant", "blessing", "curse", "spell", "vow", "promise", "oath",
  "dream", "vision", "sign", "omen", "warning", "message", "calling", "presence", "absence", "gift",
];

const SCRAMBLE = 2147483647;

export function nextOvilusWord(seed: number, entropy: number): { word: string; nextSeed: number } {
  const next = (Math.imul(seed | 0, 1103515245) + ((entropy * 1e6) | 0) + 12345) & SCRAMBLE;
  const idx = Math.abs(next) % OVILUS_DICTIONARY.length;
  return { word: OVILUS_DICTIONARY[idx], nextSeed: next };
}
