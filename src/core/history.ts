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
        const text = live.getText(key);
        text.delete(0, text.length);
        text.applyDelta(old.getText(key).toDelta());
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
