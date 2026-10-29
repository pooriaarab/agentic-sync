// Peer names show on other people's screens, so they use a closed set:
// letters, marks, digits, and a few marks of punctuation. Format
// controls (bidi, zero-width, tags), separators, fillers, and variation
// selectors are all outside the set, so a name cannot hide text or
// flip the reading order around it.
export const MAX_NAME_LENGTH = 40;
export const FALLBACK_NAME = "Unknown";
// Zalgo guard: no more than this many combining marks in a row.
const MAX_MARK_RUN = 3;

const WORD = String.raw`[\p{L}\p{N}]`;
const PART = String.raw`(?:${WORD}\p{M}*)`;
const PUNCT = String.raw`[ ._'’()-]`;
const SHAPE = new RegExp(`^${PART}(?:${PART}|${PUNCT})*$`, "u");
// Letters and marks that draw nothing.
const INVISIBLE = /[\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/u;
const MARK_RUN = new RegExp(String.raw`\p{M}{${MAX_MARK_RUN + 1},}`, "u");

// True when the name is safe to show. It must already be in the plain
// form: NFC, no space at either end, and no two spaces in a row.
export function isSafePeerName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > MAX_NAME_LENGTH * 2) return false;
  if (name !== name.normalize("NFC")) return false;
  if ([...name].length > MAX_NAME_LENGTH) return false;
  if (name.startsWith(" ") || name.endsWith(" ") || name.includes("  ")) return false;
  if (INVISIBLE.test(name) || MARK_RUN.test(name)) return false;
  return SHAPE.test(name);
}

// Throws for a name that is not safe. Use it on input you must refuse.
export function assertSafePeerName(name: unknown): string {
  if (!isSafePeerName(name)) {
    throw new Error(`peer name must be 1 to ${MAX_NAME_LENGTH} letters, digits, spaces, or . _ ' -`);
  }
  return name;
}

// The name, or a fallback for one that is not safe. Use it on names
// that come from other peers.
export function displayPeerName(name: unknown): string {
  return isSafePeerName(name) ? name : FALLBACK_NAME;
}
