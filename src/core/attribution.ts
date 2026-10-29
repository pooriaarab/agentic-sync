import * as Y from "yjs";
import { isMachineKind, PRINCIPAL_KINDS, type Contributor, type Principal } from "./types.js";

export const DEFAULT_MAX_RANGES = 4000;
// More ranges could push the saved log past the 2 MiB storage value limit.
export const LARGEST_MAX_RANGES = 5000;

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
  // True when the saved log was damaged. Everything before that has no author here.
  lost: boolean;
}

const isWhole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

// Which principal sent which content. It keeps at most `maxRanges` ranges.
// Past that, the oldest go first and their text reads as unattributed.
export class AttributionLog {
  private authors: Principal[] = [];
  private ranges: AttributionRange[] = [];
  private dropped = 0;
  private lost = false;
  private newest = new Map<number, AttributionRange>();

  constructor(private readonly maxRanges = DEFAULT_MAX_RANGES) {}

  // Reads a log back from storage. Throws on bad data, so a damaged log
  // never labels machine-made text as a person's.
  static from(saved: unknown, maxRanges = DEFAULT_MAX_RANGES): AttributionLog {
    const log = new AttributionLog(maxRanges);
    if (saved === undefined) return log;
    const { authors, ranges, dropped, lost } = saved as Record<string, any>;
    if (!Array.isArray(authors) || !Array.isArray(ranges) || !isWhole(dropped) || (lost !== undefined && typeof lost !== "boolean")) {
      throw new Error("stored attribution is damaged");
    }
    for (const author of authors) {
      if (typeof author?.id !== "string" || !PRINCIPAL_KINDS.includes(author.kind)) {
        throw new Error("stored attribution is damaged");
      }
      log.authors.push({ id: author.id, kind: author.kind });
    }
    for (const range of ranges) {
      const ok = isWhole(range?.client) && isWhole(range?.clock) && isWhole(range?.at) &&
        Number.isSafeInteger(range?.length) && range.length > 0 &&
        Number.isSafeInteger(range?.author) && range.author >= 0 && range.author < authors.length;
      if (!ok) throw new Error("stored attribution is damaged");
      log.ranges.push({ client: range.client, clock: range.clock, length: range.length, author: range.author, at: range.at });
    }
    log.dropped = dropped;
    log.lost = lost === true;
    log.reindex();
    return log;
  }

  // Starts a new log in place of a damaged one, and says so.
  static lost(maxRanges = DEFAULT_MAX_RANGES): AttributionLog {
    const log = new AttributionLog(maxRanges);
    log.lost = true;
    return log;
  }

  private static key = (p: Principal) => `${p.kind}:${p.id}`;

  private indexOf(author: Principal): number {
    return this.authors.findIndex((known) => AttributionLog.key(known) === AttributionLog.key(author));
  }

  private static structsOf(update: Uint8Array) {
    return Y.decodeUpdate(update).structs.filter((s) => s instanceof Y.Item || s instanceof Y.GC);
  }

  // True when `update` carries ids that a range of another principal holds.
  // A sender may not write under the client id of someone else.
  conflicts(update: Uint8Array, author: Principal): boolean {
    const index = this.indexOf(author);
    return AttributionLog.structsOf(update).some((struct) => {
      const held = this.newest.get(struct.id.client);
      return held !== undefined && held.author !== index;
    });
  }

  // Notes that `author` sent every struct in `update`.
  record(update: Uint8Array, author: Principal, at: number): void {
    let index = this.indexOf(author);
    if (index < 0) index = this.authors.push({ id: author.id, kind: author.kind }) - 1;
    for (const struct of AttributionLog.structsOf(update)) {
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
      // Drop a tenth more than needed, so a full log does not shift on every update.
      const drop = Math.min(this.ranges.length, over + Math.floor(this.maxRanges / 10));
      this.ranges.splice(0, drop);
      this.dropped += drop;
      this.forgetUnusedAuthors();
      this.reindex();
    }
  }

  private forgetUnusedAuthors(): void {
    const used = [...new Set(this.ranges.map((range) => range.author))].sort((a, b) => a - b);
    const moved = new Map(used.map((old, next) => [old, next]));
    this.authors = used.map((old) => this.authors[old]);
    for (const range of this.ranges) range.author = moved.get(range.author)!;
  }

  private reindex(): void {
    this.newest = new Map(this.ranges.map((range) => [range.client, range]));
  }

  toJSON(): { authors: Principal[]; ranges: AttributionRange[]; dropped: number; lost: boolean } {
    return { authors: this.authors, ranges: this.ranges, dropped: this.dropped, lost: this.lost };
  }

  // The form the API serves. The machine label comes from the kind, never from storage.
  labeled(): Attribution {
    const { authors, ...rest } = this.toJSON();
    return { authors: authors.map((a) => ({ ...a, machine: isMachineKind(a.kind) })), ...rest };
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
    const list = byClient.get(range.client);
    if (list === undefined) byClient.set(range.client, [range]);
    else list.push(range);
  }
  for (const list of byClient.values()) list.sort((a, b) => a.clock - b.clock);
  // The range that holds `at`, and where the next range starts.
  const locate = (list: AttributionRange[], at: number) => {
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (list[mid].clock <= at) low = mid + 1;
      else high = mid;
    }
    const range = low > 0 && at < list[low - 1].clock + list[low - 1].length ? list[low - 1] : undefined;
    return { range, next: list[low]?.clock ?? Infinity };
  };
  const spans: BlameSpan[] = [];
  const push = (text: string, author: Contributor | null) => {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.author?.id === author?.id && last.author?.kind === author?.kind) last.text += text;
    else spans.push({ text, author });
  };
  for (let item = doc.getText(root)._start; item !== null; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
    const { client, clock } = item.id;
    const list = byClient.get(client) ?? [];
    let offset = 0;
    while (offset < item.length) {
      const { range, next } = locate(list, clock + offset);
      // Stop where this range ends, or where the next one starts.
      const stop = range === undefined ? next : range.clock + range.length;
      const end = Math.min(item.length, stop - clock);
      push(item.content.str.slice(offset, end), range === undefined ? null : (attribution.authors[range.author] ?? null));
      offset = end;
    }
  }
  return spans;
}
