import { fromBase64, toBase64 } from "./base64.js";

// What a room keeps between runs, as keys and values. It is the subset of
// Durable Object storage the room uses, so another backend can hold it.
// Keys are exact: never fold their case. A value is JSON plus Uint8Array.
export interface RoomStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  // Every entry whose key starts with the prefix, in UTF-8 byte order of the key.
  list<T = unknown>(prefix: string): Promise<Map<string, T>>;
  put(key: string, value: unknown): Promise<void>;
  // All entries land together or not at all. It takes up to 500 entries. A backend may cap the size
  // of a value (Firestore: about 1 MB).
  putAll(entries: Record<string, unknown>): Promise<void>;
  // Returns how many entries existed. The count is exact only when no other write races.
  delete(keys: string[]): Promise<number>;
  // Removes every entry of the document.
  deleteAll(): Promise<void>;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const MAX_KEY_BYTES = 1000;
export const MAX_PUT_ALL = 500;
const encoder = new TextEncoder();

// A key is non-empty, well-formed text of up to 1000 UTF-8 bytes. A lone surrogate
// would match another key in a UTF-8 backend, and a long key breaks the Firestore id limit.
export function assertText(text: string, what = "a key"): void {
  if (text === "" || LONE_SURROGATE.test(text) || encoder.encode(text).length > MAX_KEY_BYTES) {
    throw new Error(`${what} must be non-empty, well-formed text of up to ${MAX_KEY_BYTES} bytes`);
  }
}

// UTF-8 byte order, as Firestore sorts.
export function compareKeys(a: string, b: string): number {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

export function assertPrefix(prefix: string): void {
  if (LONE_SURROGATE.test(prefix) || encoder.encode(prefix).length > MAX_KEY_BYTES) throw new Error("a prefix must be well-formed text");
}

const BYTES = "$bytes";

const isPlain = (value: object) => {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
};

// JSON text for a value. A Uint8Array becomes { "$bytes": base64 }. It refuses
// what JSON would change or drop: undefined, functions, symbols, bigint, and
// objects such as Map or Date.
export function encodeValue(value: unknown): string {
  const text = JSON.stringify(value, function (key, item) {
    const held = (this as Record<string, unknown>)[key];
    if (held instanceof Uint8Array) return { [BYTES]: toBase64(held) };
    if (held === null || typeof held === "string" || typeof held === "boolean") return item;
    if (typeof held === "number" && Number.isFinite(held) && !Object.is(held, -0)) return item;
    if (typeof held === "object" && (Array.isArray(held) || isPlain(held))) {
      if (!Array.isArray(held) && BYTES in held) throw new Error(`a stored value must not use the key ${BYTES}`);
      return item;
    }
    throw new Error("a stored value must be JSON or bytes");
  });
  return text;
}

export function decodeValue<T>(text: string): T {
  return JSON.parse(text, (_key, item) => {
    if (item !== null && typeof item === "object" && typeof item[BYTES] === "string" && Object.keys(item).length === 1) {
      return fromBase64(item[BYTES]);
    }
    return item;
  }) as T;
}

// The reference adapter. Values pass through the codec and keys are checked.
// It does not enforce the size limits of a real backend.
export function createMemoryStorage(): RoomStorage {
  const data = new Map<string, string>();
  const sorted = () => [...data.keys()].sort(compareKeys);
  return {
    async get<T>(key: string) {
      assertText(key);
      const text = data.get(key);
      return text === undefined ? undefined : decodeValue<T>(text);
    },
    async list<T>(prefix: string) {
      assertPrefix(prefix);
      return new Map(sorted().filter((key) => key.startsWith(prefix)).map((key) => [key, decodeValue<T>(data.get(key)!)]));
    },
    async put(key, value) {
      assertText(key);
      data.set(key, encodeValue(value));
    },
    async putAll(entries) {
      if (Object.keys(entries).length > MAX_PUT_ALL) throw new Error(`putAll takes up to ${MAX_PUT_ALL} entries`);
      const encoded = Object.entries(entries).map(([key, value]) => (assertText(key), [key, encodeValue(value)] as const));
      for (const [key, text] of encoded) data.set(key, text);
    },
    async delete(keys) {
      keys.forEach((key) => assertText(key));
      return keys.filter((key) => data.delete(key)).length;
    },
    async deleteAll() {
      data.clear();
    },
  };
}

// Everything stored for a document, as lines of JSON, one record each.
// Bytes show as base64. A write that lands during the stream may or may not be in it.
export function exportStorage(storage: RoomStorage): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const line = (record: object) => encoder.encode(`${JSON.stringify(record)}\n`);
  async function* records() {
    yield line({ type: "meta", format: "agentic-realtime-storage-export", version: 1, exportedAt: Date.now() });
    for (const [key, value] of await storage.list("")) {
      yield line({ type: "entry", key, value: JSON.parse(encodeValue(value)) });
    }
  }
  const iterator = records();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
