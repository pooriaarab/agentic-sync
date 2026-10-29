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

// One UTF-16 unit of text, or one embed, with its formatting.
interface Unit {
  // The character or embed alone. Two units with the same char differ only in formatting.
  char: string;
  attributes: Attributes;
  op: Delta;
}

function unitsOf(text: Y.Text): Unit[] {
  return (text.toDelta() as Delta[]).flatMap((op) => {
    const attributes = op.attributes ?? {};
    if (typeof op.insert !== "string") return [{ char: `\0${JSON.stringify(op.insert)}`, attributes, op }];
    return op.insert.split("").map((unit) => ({ char: unit, attributes, op: { insert: unit, attributes: op.attributes } }));
  });
}

// What to set on a unit with `from` formatting to give it `to` formatting. Null removes a key.
function attributeChange(from: Attributes, to: Attributes): Attributes | null {
  const change: Attributes = {};
  for (const key of Object.keys(to)) if (JSON.stringify(from[key]) !== JSON.stringify(to[key])) change[key] = to[key];
  for (const key of Object.keys(from)) if (!(key in to)) change[key] = null;
  return Object.keys(change).length > 0 ? change : null;
}

// Keeps units whose characters match and only changes their formatting.
function retainWithFormat(now: Unit[], then: Unit[]): Delta[] {
  const ops: { retain: number; attributes?: Attributes }[] = [];
  now.forEach((unit, i) => {
    const change = attributeChange(unit.attributes, then[i].attributes);
    const last = ops[ops.length - 1];
    if (last !== undefined && JSON.stringify(last.attributes) === JSON.stringify(change ?? undefined)) last.retain += 1;
    else ops.push({ retain: 1, ...(change === null ? {} : { attributes: change }) });
  });
  return ops as unknown as Delta[];
}

const copyEmbed = (value: string | object): string | object =>
  value instanceof Y.AbstractType ? (value as Y.Map<unknown>).clone() : value;

// Makes `text` hold what `target` holds. Units with the same character stay,
// so their authors stay, and only their formatting changes. Characters that
// differ are deleted and inserted again.
function rewriteText(text: Y.Text, target: Y.Text): void {
  const [now, then] = [unitsOf(text), unitsOf(target)];
  let head = 0;
  while (head < now.length && head < then.length && now[head].char === then[head].char) head++;
  // Never cut between the two halves of a surrogate pair.
  if (head > 0 && (now[head - 1].char.charCodeAt(0) & 0xfc00) === 0xd800) head--;
  let tail = 0;
  while (tail < now.length - head && tail < then.length - head && now[now.length - 1 - tail].char === then[then.length - 1 - tail].char) tail++;
  if (tail > 0 && (now[now.length - tail].char.charCodeAt(0) & 0xfc00) === 0xdc00) tail--;
  const [nowMiddle, thenMiddle] = [now.slice(head, now.length - tail), then.slice(head, then.length - tail)];
  const runs: Delta[] = [];
  for (const { op } of thenMiddle) {
    const last = runs[runs.length - 1];
    const format = JSON.stringify(op.attributes);
    if (last !== undefined && typeof last.insert === "string" && typeof op.insert === "string" && JSON.stringify(last.attributes) === format) {
      last.insert += op.insert;
    } else runs.push({ insert: copyEmbed(op.insert), ...(op.attributes === undefined ? {} : { attributes: op.attributes }) });
  }
  text.applyDelta([
    ...retainWithFormat(now.slice(0, head), then.slice(0, head)),
    ...(nowMiddle.length > 0 ? [{ delete: nowMiddle.length }] : []),
    ...runs,
    ...retainWithFormat(now.slice(now.length - tail), then.slice(then.length - tail)),
  ]);
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
