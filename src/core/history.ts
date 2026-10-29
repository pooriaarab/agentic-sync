import * as Y from "yjs";

export type Kind = "text" | "map" | "array" | "xml";

const TEXT_REFS = [4, 5, 6]; // string, embed, format content

// A root type no code has opened is a bare placeholder, so read its items.
function kindOf(type: Y.AbstractType<any>): Kind {
  if (type instanceof Y.XmlFragment) return "xml";
  if (type instanceof Y.Text) return "text";
  if (type instanceof Y.Map) return "map";
  if (type instanceof Y.Array) return "array";
  if (type._start === null) return type._map.size > 0 ? "map" : "array";
  let item: Y.Item | null = type._start;
  while (item?.deleted) item = item.right;
  if (item === null) return "array";
  if (TEXT_REFS.includes(item.content.getRef())) return "text";
  const held = (item.content as { type?: unknown }).type;
  return held instanceof Y.XmlElement || held instanceof Y.XmlText ? "xml" : "array";
}

// True when a root type holds nothing, so any type can still claim it.
const isEmpty = (type: Y.AbstractType<any>): boolean =>
  type._length === 0 && [...type._map.values()].every((item) => item.deleted);

// What a root holds, so an edit can refuse a root of the wrong type.
// A root that does not exist, or has no content, reads as "empty".
export function rootKind(doc: Y.Doc, root: string): Kind | "empty" {
  const type = doc.share.get(root);
  return type === undefined || isEmpty(type) ? "empty" : kindOf(type);
}

const copy = (value: unknown): unknown =>
  value instanceof Y.AbstractType ? (value as Y.Map<unknown>).clone() : value;

type Attributes = Record<string, unknown>;
type Delta = { insert: string | object; attributes?: Attributes };

// One character (a surrogate pair counts as one), or one embed, with its formatting.
interface Unit {
  // The character or embed alone. Two units with the same char differ only in formatting.
  char: string;
  // Its length in the text, which a delta counts in UTF-16 units.
  length: number;
  attributes: Attributes;
  op: Delta;
}

function unitsOf(text: Y.Text): Unit[] {
  return (text.toDelta() as Delta[]).flatMap((op) => {
    const attributes = op.attributes ?? {};
    if (typeof op.insert !== "string") return [{ char: `\0${JSON.stringify(op.insert)}`, length: 1, attributes, op }];
    return (op.insert.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^]/g) ?? []).map((char) => ({
      char,
      length: char.length,
      attributes,
      op: { insert: char, attributes: op.attributes },
    }));
  });
}

// The most changes the diff looks for. A text that differs more is replaced in the middle.
const MAX_DIFF_EDITS = 600;

type Step = "=" | "-" | "+";

// A shortest list of equal, delete, and insert steps from `a` to `b` (Myers), or
// null when it needs more than MAX_DIFF_EDITS changes.
function diff(a: string[], b: string[]): Step[] | null {
  const [n, m] = [a.length, b.length];
  const limit = Math.min(n + m, MAX_DIFF_EDITS);
  const offset = limit + 1;
  let v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) (x++, y++);
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, offset);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], found: number, n: number, m: number, offset: number): Step[] {
  const steps: Step[] = [];
  let [x, y] = [n, m];
  for (let d = found; d > 0; d--) {
    const before = trace[d];
    const k = x - y;
    const previousK = k === -d || (k !== d && before[offset + k - 1] < before[offset + k + 1]) ? k + 1 : k - 1;
    const [previousX, previousY] = [before[offset + previousK], before[offset + previousK] - previousK];
    while (x > previousX && y > previousY) (steps.push("="), x--, y--);
    steps.push(x === previousX ? "+" : "-");
    [x, y] = [previousX, previousY];
  }
  while (x > 0 && y > 0) (steps.push("="), x--, y--);
  return steps.reverse();
}

// What to set on a unit with `from` formatting to give it `to` formatting. Null removes a key.
function attributeChange(from: Attributes, to: Attributes): Attributes | null {
  const change: Attributes = {};
  for (const key of Object.keys(to)) if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) change[key] = to[key];
  for (const key of Object.keys(from)) if (!Object.hasOwn(to, key)) change[key] = null;
  return Object.keys(change).length > 0 ? change : null;
}

// Keeps units whose characters match and only changes their formatting.
function retainWithFormat(now: Unit[], then: Unit[]): Delta[] {
  const ops: { retain: number; attributes?: Attributes }[] = [];
  now.forEach((unit, i) => {
    const change = attributeChange(unit.attributes, then[i].attributes);
    const last = ops[ops.length - 1];
    if (last !== undefined && JSON.stringify(last.attributes) === JSON.stringify(change ?? undefined)) last.retain += unit.length;
    else ops.push({ retain: unit.length, ...(change === null ? {} : { attributes: change }) });
  });
  return ops as unknown as Delta[];
}

const copyEmbed = (value: string | object): string | object =>
  value instanceof Y.AbstractType ? (value as Y.Map<unknown>).clone() : value;

function insertRuns(units: Unit[]): Delta[] {
  const runs: Delta[] = [];
  for (const { op } of units) {
    const last = runs[runs.length - 1];
    const format = JSON.stringify(op.attributes);
    if (last !== undefined && typeof last.insert === "string" && typeof op.insert === "string" && JSON.stringify(last.attributes) === format) {
      last.insert += op.insert;
    } else runs.push({ insert: copyEmbed(op.insert), ...(op.attributes === undefined ? {} : { attributes: op.attributes }) });
  }
  return runs;
}

// Makes `text` hold what `target` holds. A diff keeps the units that match, so
// they keep their authors and only their formatting changes. The rest is
// deleted and inserted again. A text that differs in more than MAX_DIFF_EDITS
// places is replaced between its shared start and end.
function rewriteText(text: Y.Text, target: Y.Text): void {
  const [now, then] = [unitsOf(text), unitsOf(target)];
  let head = 0;
  while (head < now.length && head < then.length && now[head].char === then[head].char) head++;
  let tail = 0;
  while (tail < now.length - head && tail < then.length - head && now[now.length - 1 - tail].char === then[then.length - 1 - tail].char) tail++;
  const [nowMiddle, thenMiddle] = [now.slice(head, now.length - tail), then.slice(head, then.length - tail)];
  const steps = diff(nowMiddle.map((unit) => unit.char), thenMiddle.map((unit) => unit.char)) ??
    [...nowMiddle.map((): Step => "-"), ...thenMiddle.map((): Step => "+")];
  const ops: Delta[] = [...retainWithFormat(now.slice(0, head), then.slice(0, head))];
  let [i, j] = [0, 0];
  for (let s = 0; s < steps.length; ) {
    let end = s;
    while (end < steps.length && steps[end] === steps[s]) end++;
    const count = end - s;
    if (steps[s] === "=") {
      ops.push(...retainWithFormat(nowMiddle.slice(i, i + count), thenMiddle.slice(j, j + count)));
      [i, j] = [i + count, j + count];
    } else if (steps[s] === "-") {
      ops.push({ delete: nowMiddle.slice(i, i + count).reduce((sum, unit) => sum + unit.length, 0) } as unknown as Delta);
      i += count;
    } else {
      ops.push(...insertRuns(thenMiddle.slice(j, j + count)));
      j += count;
    }
    s = end;
  }
  ops.push(...retainWithFormat(now.slice(now.length - tail), then.slice(then.length - tail)));
  text.applyDelta(ops);
}

// Makes the live document hold the content of an older state, as one new
// update. Nothing already stored changes, so every version stays reachable.
export function restoreState(live: Y.Doc, state: Uint8Array, origin?: unknown): void {
  const old = new Y.Doc();
  Y.applyUpdate(old, state);
  live.transact(() => {
    for (const key of new Set([...live.share.keys(), ...old.share.keys()])) {
      const mine = live.share.get(key);
      const kind = kindOf(mine && mine.constructor !== Y.AbstractType ? mine : (old.share.get(key) ?? mine!));
      if (kind === "text") {
        rewriteText(live.getText(key), old.getText(key));
      } else if (kind === "map") {
        const map = live.getMap(key);
        const before = old.getMap(key);
        for (const existing of [...map.keys()]) if (!before.has(existing)) map.delete(existing);
        for (const [name, value] of before) map.set(name, copy(value));
      } else if (kind === "array") {
        const list = live.getArray(key);
        list.delete(0, list.length);
        list.insert(0, old.getArray(key).toArray().map(copy));
      } else {
        const fragment = live.getXmlFragment(key);
        fragment.delete(0, fragment.length);
        fragment.insert(0, old.getXmlFragment(key).toArray().map((node) => node.clone()) as Y.XmlElement[]);
      }
    }
  }, origin);
}

// Reads every root type of a document as plain JSON.
export function readRoots(doc: Y.Doc): Record<string, unknown> {
  return Object.fromEntries(
    [...doc.share].map(([key, type]) => {
      const kind = kindOf(type);
      if (kind === "text") return [key, doc.getText(key).toString()];
      if (kind === "xml") return [key, doc.getXmlFragment(key).toString()];
      return [key, kind === "map" ? doc.getMap(key).toJSON() : doc.getArray(key).toJSON()];
    }),
  );
}
