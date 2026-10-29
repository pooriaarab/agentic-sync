import * as Y from "yjs";
import { isMachineKind, PRINCIPAL_KINDS, type Contributor, type Principal } from "./types.js";

export const DEFAULT_MAX_RANGES = 4000;

// Yjs names every piece of content by (client id, clock). A range is a
// run of those names that one principal sent.
export interface AttributionRange {
  client: number;
  clock: number;
  length: number;
  // Index into `authors`.
  author: number;
  // When the newest update merged into this range arrived.
  at: number;
}

export interface Attribution {
  authors: Contributor[];
  ranges: AttributionRange[];
  // How many older ranges the size limit pushed out. Their content has no author here.
  dropped: number;
}

// Which principal sent which content. It keeps at most `maxRanges` ranges.
// Past that, the oldest go first and their text reads as unattributed.
export class AttributionLog {
  private authors: Principal[] = [];
  private ranges: AttributionRange[] = [];
  private dropped = 0;
  private newest = new Map<number, AttributionRange>();

  constructor(private readonly maxRanges = DEFAULT_MAX_RANGES) {}

  // Reads a log back from storage. Throws on bad data, so a damaged log
  // never labels machine-made text as a person's.
  static from(saved: unknown, maxRanges = DEFAULT_MAX_RANGES): AttributionLog {
    const log = new AttributionLog(maxRanges);
    if (saved === undefined) return log;
    const { authors, ranges, dropped } = saved as { authors?: unknown; ranges?: unknown; dropped?: unknown };
    const whole = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    if (!Array.isArray(authors) || !Array.isArray(ranges) || !whole(dropped)) {
      throw new Error("stored attribution is damaged");
    }
    for (const author of authors) {
      if (typeof author?.id !== "string" || !PRINCIPAL_KINDS.includes(author.kind)) {
        throw new Error("stored attribution is damaged");
      }
      log.authors.push({ id: author.id, kind: author.kind });
    }
    for (const range of ranges) {
      const ok = whole(range?.client) && whole(range?.clock) && whole(range?.at) &&
        Number.isSafeInteger(range?.length) && range.length > 0 &&
        Number.isSafeInteger(range?.author) && range.author >= 0 && range.author < authors.length;
      if (!ok) throw new Error("stored attribution is damaged");
      log.ranges.push({ client: range.client, clock: range.clock, length: range.length, author: range.author, at: range.at });
    }
    log.dropped = dropped as number;
    log.reindex();
    return log;
  }

  // Notes that `author` sent every struct in `update`. Content that an
  // earlier range already names keeps its first author.
  record(update: Uint8Array, author: Principal, at: number): void {
    const key = (p: Principal) => `${p.kind}:${p.id}`;
    let index = this.authors.findIndex((known) => key(known) === key(author));
    if (index < 0) index = this.authors.push({ id: author.id, kind: author.kind }) - 1;
    for (const struct of Y.decodeUpdate(update).structs) {
      if (!(struct instanceof Y.Item) && !(struct instanceof Y.GC)) continue;
      const { client, clock } = struct.id;
      const last = this.newest.get(client);
      if (last !== undefined && last.author === index && last.clock + last.length === clock) {
        last.length += struct.length;
        last.at = at;
        continue;
      }
      const range = { client, clock, length: struct.length, author: index, at };
      this.ranges.push(range);
      this.newest.set(client, range);
    }
    const over = this.ranges.length - this.maxRanges;
    if (over > 0) {
      this.ranges.splice(0, over);
      this.dropped += over;
      this.reindex();
    }
  }

  private reindex(): void {
    this.newest = new Map(this.ranges.map((range) => [range.client, range]));
  }

  toJSON(): { authors: Principal[]; ranges: AttributionRange[]; dropped: number } {
    return { authors: this.authors, ranges: this.ranges, dropped: this.dropped };
  }

  // The form the API serves. The machine label comes from the kind, never from storage.
  labeled(): Attribution {
    const { authors, ranges, dropped } = this.toJSON();
    return { authors: authors.map((a) => ({ ...a, machine: isMachineKind(a.kind) })), ranges, dropped };
  }
}

export interface BlameSpan {
  text: string;
  // Null when no range names this text.
  author: Contributor | null;
}

// Splits a text root into runs, each with the principal that sent it.
export function blameText(doc: Y.Doc, root: string, attribution: Attribution): BlameSpan[] {
  const byClient = new Map<number, AttributionRange[]>();
  for (const range of attribution.ranges) {
    byClient.set(range.client, [...(byClient.get(range.client) ?? []), range]);
  }
  const spans: BlameSpan[] = [];
  const push = (text: string, author: Contributor | null) => {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.author?.id === author?.id && last.author?.kind === author?.kind) last.text += text;
    else spans.push({ text, author });
  };
  for (let item = doc.getText(root)._start; item !== null; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
    const { client, clock } = item.id;
    let offset = 0;
    while (offset < item.length) {
      const at = clock + offset;
      const mine = byClient.get(client) ?? [];
      const range = mine.find((r) => r.clock <= at && at < r.clock + r.length);
      // Stop where this range ends, or where the next one starts.
      const stop = range === undefined
        ? Math.min(Infinity, ...mine.filter((r) => r.clock > at).map((r) => r.clock))
        : range.clock + range.length;
      const end = Math.min(item.length, stop - clock);
      push(item.content.str.slice(offset, end), range === undefined ? null : (attribution.authors[range.author] ?? null));
      offset = end;
    }
  }
  return spans;
}
