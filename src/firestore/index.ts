// Firestore adapter for RoomStorage. It speaks the Firestore REST API through an
// injected `fetch`, so it runs in Workers, Node, and Cloud Functions without the
// Firebase SDK. It imports nothing from Google and makes no call you did not set up.
//
// A document keeps its entries in `<collection>/<doc>/kv/<id>`. Each entry holds
// the exact key and the value as JSON text (bytes as base64). A Firestore document
// holds up to 1 MiB, so one value must stay under 1 MB. The adapter throws when it
// does not, and never puts content in an error.
import { MAX_PUT_ALL, assertPrefix, assertText, decodeValue, encodeValue, type RoomStorage } from "../core/storage.js";

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
const BATCH_GET = 100;

const base64Url = (text: string) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// The first string after every string with this prefix.
export function prefixEnd(prefix: string): string | null {
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
  assertText(options.docId, "docId");
  const safe = /^[A-Za-z0-9_.:()-]+$/;
  for (const [what, value] of [["projectId", options.projectId], ["databaseId", options.databaseId ?? "(default)"], ["collection", options.collection ?? "agentic_realtime"]] as const) {
    if (!safe.test(value)) throw new Error(`${what} has a character Firestore does not allow in a name`);
  }
  const database = `projects/${options.projectId}/databases/${options.databaseId ?? "(default)"}`;
  const root = `${(options.baseUrl ?? "https://firestore.googleapis.com").replace(/\/+$/, "")}/v1/${database}/documents`;
  const parent = `${options.collection ?? "agentic_realtime"}/${base64Url(options.docId)}`;

  async function call<T>(method: "POST", path: string, body?: unknown): Promise<T | null> {
    const token = typeof options.token === "function" ? await options.token() : options.token;
    // An operation such as ":commit" joins the documents path with no slash.
    const response = await options.fetch(`${root}${path.startsWith(":") ? "" : "/"}${path}`, {
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
    if (!response.ok) {
      const status = (parsed as { error?: { status?: unknown } } | null)?.error?.status;
      throw new FirestoreError(response.status, typeof status === "string" ? status : "UNKNOWN");
    }
    return parsed as T;
  }

  const idOf = (key: string) => {
    assertText(key, "a key");
    return base64Url(key);
  };
  const damaged = () => new Error("a stored entry is damaged");
  const read = (fields: Record<string, { stringValue?: string }> | undefined, key?: string) => {
    const text = fields?.value?.stringValue;
    if (text === undefined || (key !== undefined && fields?.key?.stringValue !== key)) throw damaged();
    try {
      return decodeValue<never>(text);
    } catch {
      throw damaged();
    }
  };
  const nameOf = (key: string) => `${database}/documents/${parent}/kv/${idOf(key)}`;
  const writeOf = (key: string, value: unknown): Write => {
    assertText(key);
    const json = encodeValue(value);
    if (new TextEncoder().encode(json).length > MAX_VALUE_BYTES) throw new Error("a stored value is over 1 MB, the Firestore limit");
    return { update: { name: nameOf(key), fields: { key: { stringValue: key }, value: { stringValue: json } } } };
  };
  const commit = (writes: Write[]) => call("POST", ":commit", { writes });

  async function list<T>(prefix: string): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    assertPrefix(prefix);
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
        if (key === undefined) throw damaged();
        found.set(key, read(fields) as T);
        after = key;
      }
      if (docs.length < PAGE) return found;
    }
  }

  return {
    async get<T>(key: string) {
      // batchGet names a missing document. A bare 404 could also mean a wrong database, and must not read as "missing".
      const rows = await call<{ found?: { fields?: Record<string, { stringValue?: string }> }; missing?: string }[]>("POST", ":batchGet", {
        documents: [nameOf(key)],
        mask: { fieldPaths: ["key", "value"] },
      });
      const row = rows?.[0];
      if (row?.missing === nameOf(key)) return undefined;
      if (row?.found === undefined) throw damaged();
      return read(row.found.fields, key) as T;
    },
    list,
    async put(key, value) {
      await commit([writeOf(key, value)]);
    },
    async putAll(entries) {
      const writes = Object.entries(entries).map(([key, value]) => writeOf(key, value));
      if (writes.length > MAX_PUT_ALL) throw new Error(`putAll takes up to ${MAX_PUT_ALL} entries`);
      if (writes.length > 0) await commit(writes);
    },
    async delete(keys) {
      const unique = [...new Set(keys)];
      const writes = unique.map((key): Write => ({ delete: nameOf(key) }));
      let existed = 0;
      for (let i = 0; i < writes.length; i += BATCH_GET) {
        const found = await call<{ found?: unknown }[]>("POST", ":batchGet", { documents: writes.slice(i, i + BATCH_GET).map((w) => w.delete), mask: { fieldPaths: ["key"] } });
        existed += (found ?? []).filter((row) => row.found !== undefined).length;
      }
      for (let i = 0; i < writes.length; i += COMMIT_WRITES) await commit(writes.slice(i, i + COMMIT_WRITES));
      return existed;
    },
    async deleteAll() {
      // Page over document names only, so a damaged entry cannot block the erase.
      for (;;) {
        const rows =
          (await call<Row[]>("POST", `${parent}:runQuery`, {
            structuredQuery: { from: [{ collectionId: "kv" }], select: { fields: [{ fieldPath: "__name__" }] }, limit: COMMIT_WRITES },
          })) ?? [];
        const writes = rows.flatMap((row) => (row.document ? [{ delete: row.document.name }] : []));
        if (writes.length === 0) return;
        await commit(writes);
      }
    },
  };
}
