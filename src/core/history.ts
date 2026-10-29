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
  // Names the unit in the Yjs history. The live text and an older state of it
  // hold the same unit under the same id, so a match by id is the same text.
  id: string;
  // Its length in the text, which a delta counts in UTF-16 units.
  length: number;
  attributes: Attributes;
  op: Delta;
}

// Walks the items of a text root, in order, with the formatting in effect.
function unitsOf(text: Y.Text): Unit[] {
  const units: Unit[] = [];
  const attributes: Attributes = {};
  for (let item = text._start; item !== null; item = item.right) {
    if (item.deleted) continue;
    const { client, clock } = item.id;
    const copy = () => ({ ...attributes });
    const format = () => (Object.keys(attributes).length > 0 ? { attributes: copy() } : {});
    if (item.content instanceof Y.ContentFormat) {
      const { key, value } = item.content;
      if (value === null) delete attributes[key];
      else attributes[key] = value;
    } else if (item.content instanceof Y.ContentString) {
      let offset = 0;
      for (const char of item.content.str.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^]/g) ?? []) {
        units.push({ id: `${client}:${clock + offset}`, length: char.length, attributes: copy(), op: { insert: char, ...format() } });
        offset += char.length;
      }
    } else if (item.content instanceof Y.ContentEmbed || item.content instanceof Y.ContentType) {
      // A plain embed, or a Yjs type embedded in the text.
      const embed = item.content instanceof Y.ContentEmbed ? item.content.embed : (item.content.type as unknown as object);
      units.push({ id: `${client}:${clock}`, length: 1, attributes: copy(), op: { insert: embed, ...format() } });
    }
  }
  return units;
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

// Makes `text` hold what `target` holds. Both are states of one document, so a
// unit with the same id in both is the same text: it stays, with its author, and
// only its formatting can change. Units only the live text has are deleted.
// Units only the target has were deleted since, so they come back as new text.
function rewriteText(text: Y.Text, target: Y.Text): void {
  const [now, then] = [unitsOf(text), unitsOf(target)];
  const [nowIds, thenIds] = [new Set(now.map((unit) => unit.id)), new Set(then.map((unit) => unit.id))];
  const ops: Delta[] = [];
  const length = (units: Unit[]) => units.reduce((sum, unit) => sum + unit.length, 0);
  let [i, j] = [0, 0];
  while (i < now.length || j < then.length) {
    const [fromNow, fromThen] = [i, j];
    if (i < now.length && j < then.length && now[i].id === then[j].id) {
      while (i < now.length && j < then.length && now[i].id === then[j].id) (i++, j++);
      ops.push(...retainWithFormat(now.slice(fromNow, i), then.slice(fromThen, j)));
    } else if (i < now.length && !thenIds.has(now[i].id)) {
      while (i < now.length && !thenIds.has(now[i].id)) i++;
      ops.push({ delete: length(now.slice(fromNow, i)) } as unknown as Delta);
    } else if (j < then.length && !nowIds.has(then[j].id)) {
      while (j < then.length && !nowIds.has(then[j].id)) j++;
      ops.push(...insertRuns(then.slice(fromThen, j)));
    } else {
      // The two texts disagree on the order of shared units. Yjs never does that,
      // so replace what is left whole and keep the result right.
      ops.push({ delete: length(now.slice(i)) } as unknown as Delta, ...insertRuns(then.slice(j)));
      break;
    }
  }
  text.applyDelta(ops.filter((op) => !("delete" in op && op.delete === 0)));
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
