// Firestore adapter for RoomStorage. It speaks the Firestore REST API through an
// injected `fetch`, so it runs in Workers, Node, and Cloud Functions without the
// Firebase SDK. It imports nothing from Google and makes no call you did not set up.
//
// A document keeps its entries in `<collection>/<doc>/kv/<id>`. Each entry holds
// the exact key and the value as JSON text (bytes as base64). A Firestore document
// holds up to 1 MiB, so one value must stay under 1 MB. The adapter throws when it
// does not, and never puts content in an error.
import { decodeValue, encodeValue, type RoomStorage } from "../core/storage.js";

export interface FirestoreStorageOptions {
  projectId: string;
  /** The document this storage holds. Its case is kept. */
  docId: string;
  /** Defaults to `(default)`. */
  databaseId?: string;
  /** Root collection. Defaults to `agentic_realtime`. */
  collection?: string;
  /** The `fetch` to call. Pass `globalThis.fetch`, or a wrapper that adds retries. */
  fetch: typeof fetch;
  /** An OAuth access token, or a function that returns one. Leave it out for the emulator. */
  token?: string | (() => string | Promise<string>);
  /** Defaults to `https://firestore.googleapis.com`. For the emulator, use `http://<FIRESTORE_EMULATOR_HOST>`. */
  baseUrl?: string;
}

/** A Firestore call failed. It holds the HTTP status and the Firestore status code, never a value. */
export class FirestoreError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(`firestore request failed: ${httpStatus} ${code}`);
    this.name = "FirestoreError";
  }
}

export const MAX_VALUE_BYTES = 1_000_000;
const PAGE = 300;
// A commit takes up to 500 writes.
const COMMIT_WRITES = 500;

const base64Url = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// The first string after every string with this prefix.
function prefixEnd(prefix: string): string | null {
  const points = [...prefix];
  while (points.length > 0) {
    const last = points.pop()!.codePointAt(0)!;
    if (last < 0x10ffff) return points.join("") + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
  }
  return null;
}

interface Write {
  update?: { name: string; fields: Record<string, { stringValue: string }> };
  delete?: string;
}
interface Row {
  document?: { name: string; fields?: Record<string, { stringValue?: string }> };
}

export function createFirestoreStorage(options: FirestoreStorageOptions): RoomStorage {
  if (options.docId === "") throw new Error("docId must not be empty");
  const database = `projects/${options.projectId}/databases/${options.databaseId ?? "(default)"}`;
  const root = `${(options.baseUrl ?? "https://firestore.googleapis.com").replace(/\/+$/, "")}/v1/${database}/documents`;
  const parent = `${options.collection ?? "agentic_realtime"}/${base64Url(options.docId)}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
    const token = typeof options.token === "function" ? await options.token() : options.token;
    const response = await options.fetch(`${root}/${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // Not JSON: report the status only.
    }
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) {
      const status = (parsed as { error?: { status?: unknown } } | null)?.error?.status;
      throw new FirestoreError(response.status, typeof status === "string" ? status : "UNKNOWN");
    }
    return parsed as T;
  }

  const idOf = (key: string) => base64Url(key);
  const nameOf = (key: string) => `${database}/documents/${parent}/kv/${idOf(key)}`;
  const writeOf = (key: string, value: unknown): Write => {
    const json = encodeValue(value);
    if (new TextEncoder().encode(json).length > MAX_VALUE_BYTES) throw new Error("a stored value is over 1 MB, the Firestore limit");
    return { update: { name: nameOf(key), fields: { key: { stringValue: key }, value: { stringValue: json } } } };
  };
  const commit = (writes: Write[]) => call("POST", ":commit", { writes });

  async function list<T>(prefix: string): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    const end = prefixEnd(prefix);
    const filters: object[] = [];
    if (prefix !== "") filters.push({ fieldFilter: { field: { fieldPath: "key" }, op: "GREATER_THAN_OR_EQUAL", value: { stringValue: prefix } } });
    if (end !== null && prefix !== "") filters.push({ fieldFilter: { field: { fieldPath: "key" }, op: "LESS_THAN", value: { stringValue: end } } });
    let after: string | undefined;
    for (;;) {
      const structuredQuery = {
        from: [{ collectionId: "kv" }],
        ...(filters.length === 0 ? {} : { where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } } }),
        orderBy: [{ field: { fieldPath: "key" }, direction: "ASCENDING" }],
        ...(after === undefined ? {} : { startAt: { before: false, values: [{ stringValue: after }] } }),
        limit: PAGE,
      };
      const rows = (await call<Row[]>("POST", `${parent}:runQuery`, { structuredQuery })) ?? [];
      const docs = rows.flatMap((row) => (row.document?.fields ? [row.document.fields] : []));
      for (const fields of docs) {
        const key = fields.key?.stringValue;
        const value = fields.value?.stringValue;
        if (key === undefined || value === undefined) continue;
        found.set(key, decodeValue<T>(value));
        after = key;
      }
      if (docs.length < PAGE) return found;
    }
  }

  return {
    async get<T>(key: string) {
      const doc = await call<{ fields?: Record<string, { stringValue?: string }> }>("GET", `${parent}/kv/${idOf(key)}`);
      const value = doc?.fields?.value?.stringValue;
      return value === undefined ? undefined : decodeValue<T>(value);
    },
    list,
    async put(key, value) {
      await commit([writeOf(key, value)]);
    },
    async putAll(entries) {
      const writes = Object.entries(entries).map(([key, value]) => writeOf(key, value));
      if (writes.length > COMMIT_WRITES) throw new Error(`putAll takes up to ${COMMIT_WRITES} entries`);
      if (writes.length > 0) await commit(writes);
    },
    async delete(keys) {
      let existed = 0;
      for (const key of new Set(keys)) {
        if ((await call("GET", `${parent}/kv/${idOf(key)}`)) !== null) existed += 1;
      }
      const writes = [...new Set(keys)].map((key): Write => ({ delete: nameOf(key) }));
      for (let i = 0; i < writes.length; i += COMMIT_WRITES) await commit(writes.slice(i, i + COMMIT_WRITES));
      return existed;
    },
    async deleteAll() {
      const writes = [...(await list("")).keys()].map((key): Write => ({ delete: nameOf(key) }));
      for (let i = 0; i < writes.length; i += COMMIT_WRITES) await commit(writes.slice(i, i + COMMIT_WRITES));
    },
  };
}
