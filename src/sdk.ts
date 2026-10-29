import * as Y from "yjs";
import { SyncClient, type Peer } from "./client/index.js";
import { blameText, type Attribution, type BlameSpan } from "./core/attribution.js";
import { readRoots, rootKind, type Kind } from "./core/history.js";
import type { Role, SnapshotInfo } from "./core/types.js";

// Where to connect, and how to show up. The token is sent as a bearer
// header. The server decides who you are, and which kind you show as,
// from the token.
export interface Target {
  server: string;
  token?: string;
  headers?: Record<string, string>;
  name?: string;
}

export const EDIT_MODES = ["append", "replace", "insert"] as const;
export type EditMode = (typeof EDIT_MODES)[number];

const ROOT_LABELS: Record<Exclude<Kind, "text">, string> = {
  xml: "rich-text",
  map: "map",
  array: "array",
};

// Refuses a root that holds something other than text. Writing text into
// it would delete its content or put a string where an editor expects nodes.
function assertTextRoot(client: SyncClient, root: string): void {
  const held = rootKind(client.doc, root);
  if (held === "text" || held === "empty") return;
  throw new Error(
    `root "${root}" is not text. It holds ${ROOT_LABELS[held]} content, so doc_apply does not edit it.`,
  );
}

function assertTextRootOf(doc: Y.Doc, root: string): void {
  const held = rootKind(doc, root);
  if (held !== "text" && held !== "empty") {
    throw new Error(`root "${root}" is not text. It holds ${ROOT_LABELS[held]} content, so blame does not read it.`);
  }
}

function socketUrl(target: Target, docId: string): string {
  const url = new URL(target.server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/docs/${encodeURIComponent(docId)}/ws`;
  return url.toString();
}

// Joins a document, runs one job, and always leaves.
export async function withDoc<T>(
  target: Target,
  docId: string,
  job: (client: SyncClient) => Promise<T>,
): Promise<T> {
  const client = await SyncClient.connect({
    url: socketUrl(target, docId),
    headers: target.token ? { authorization: `Bearer ${target.token}` } : undefined,
    presence: { name: target.name ?? "agent" },
  });
  try {
    const result = await job(client);
    if (client.denied.length > 0) {
      throw new Error(`the server refused the edit: ${client.denied[0]}`);
    }
    return result;
  } finally {
    await client.disconnect();
  }
}

export const getDoc = (target: Target, docId: string) =>
  withDoc(target, docId, async (client) => readRoots(client.doc));

export const applyText = (
  target: Target,
  docId: string,
  edit: { root: string; text: string; mode?: EditMode; at?: number },
) =>
  withDoc(target, docId, async (client) => {
    const { root, text, mode = "append", at = 0 } = edit;
    assertTextRoot(client, root);
    await client.edit((doc) => {
      const body = doc.getText(root);
      if (mode === "replace") body.delete(0, body.length);
      const index = mode === "insert" ? Math.min(Math.max(at, 0), body.length) : body.length;
      body.insert(index, text);
    });
    return { root, length: client.doc.getText(root).length };
  });

export const createSnapshot = (target: Target, docId: string, name: string) =>
  withDoc(target, docId, (client) => client.snapshot(name));

export const listSnapshots = (target: Target, docId: string): Promise<SnapshotInfo[]> =>
  withDoc(target, docId, (client) => client.snapshots());

export const restoreSnapshot = (target: Target, docId: string, name: string) =>
  withDoc(target, docId, async (client) => {
    await client.restore(name);
    return { restored: name };
  });

async function read(target: Target, docId: string, path: string): Promise<Response> {
  const url = new URL(target.server);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/docs/${encodeURIComponent(docId)}/${path}`;
  const response = await fetch(url, {
    headers: target.token ? { authorization: `Bearer ${target.token}` } : undefined,
  });
  if (!response.ok) throw new Error(`the server refused the request: ${response.status}`);
  return response;
}

// Who sent which content, now or as of a named snapshot. Any role may read it.
export const getAttribution = async (target: Target, docId: string, snapshot?: string): Promise<Attribution> =>
  (await (await read(target, docId, snapshot === undefined ? "attribution" : `snapshots/${encodeURIComponent(snapshot)}/attribution`)).json()) as Attribution;

// Splits a text root into runs and names the principal that sent each one.
// A run no range names has `author: null`.
export async function blame(target: Target, docId: string, root: string, snapshot?: string): Promise<BlameSpan[]> {
  if (snapshot !== undefined) {
    const log = await getAttribution(target, docId, snapshot);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await (await read(target, docId, `snapshots/${encodeURIComponent(snapshot)}`)).arrayBuffer()));
    assertTextRootOf(doc, root);
    return blameText(doc, root, log);
  }
  // Join first, then read the log, so the log is never older than the text.
  return withDoc(target, docId, async (client) => {
    assertTextRootOf(client.doc, root);
    return blameText(client.doc, root, await getAttribution(target, docId));
  });
}

// One record of an export, such as `{ type: "state", base64 }`. See the README.
// The fields depend on the type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExportRecord = { type: string; [field: string]: any };

async function call(server: string, path: string, secret: string | undefined, init: RequestInit = {}, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const url = new URL(server);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
  const headers = new Headers(extraHeaders);
  if (secret !== undefined) headers.set("authorization", `Bearer ${secret}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { code: string } };
    throw new Error(`the server refused the request: ${body.error?.code ?? response.status}`);
  }
  return response;
}

// Reads a JSON-lines body as it arrives. A line can split across chunks, and
// so can a multi-byte character, so the decoder keeps its state between chunks.
async function* records(response: Response): AsyncGenerator<ExportRecord> {
  if (response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  // The unfinished line so far. Each chunk is searched only for its own
  // newlines, so a long line costs time in proportion to its length.
  let partial = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const text = decoder.decode(chunk.value, { stream: true });
      let from = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", from)) {
        const line = partial + text.slice(from, end);
        partial = "";
        from = end + 1;
        if (line !== "") yield JSON.parse(line) as ExportRecord;
      }
      partial += text.slice(from);
    }
    partial += decoder.decode();
    if (partial !== "") yield JSON.parse(partial) as ExportRecord;
  } finally {
    // A caller that stops early must not leave the connection open.
    await reader.cancel().catch(() => {});
  }
}

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const all: T[] = [];
  for await (const item of source) all.push(item);
  return all;
};

const docPath = (docId: string) => `/api/v1/docs/${encodeURIComponent(docId)}`;
const hostPath = (docId: string) => `/api/v1/admin/docs/${encodeURIComponent(docId)}`;
const confirmation = (docId: string): RequestInit => ({ method: "DELETE", body: JSON.stringify({ confirm: docId }) });

// Everything the room stores for a document, as records, one at a time as
// they arrive. Use this for a large history. Owners only.
export async function* exportDocumentStream(target: Target, docId: string): AsyncGenerator<ExportRecord> {
  yield* records(await call(target.server, `${docPath(docId)}/export`, target.token, {}, target.headers));
}

// The same records, all at once. This holds the whole export in memory.
export const exportDocument = (target: Target, docId: string) => collect(exportDocumentStream(target, docId));

// Deletes all data of a document and closes its sockets. Owners only. This cannot be undone.
export const deleteDocument = async (target: Target, docId: string) =>
  (await (await call(target.server, docPath(docId), target.token, confirmation(docId), target.headers)).json()) as { deleted: true; sockets: number };

// The same two calls for the host, with the host secret. Keep it out of agents.
export async function* exportDocumentStreamAsHost(host: AdminTarget, docId: string): AsyncGenerator<ExportRecord> {
  yield* records(await call(host.server, `${hostPath(docId)}/export`, host.secret));
}

export const exportDocumentAsHost = (host: AdminTarget, docId: string) =>
  collect(exportDocumentStreamAsHost(host, docId));

export const deleteDocumentAsHost = async (host: AdminTarget, docId: string) =>
  (await (await call(host.server, hostPath(docId), host.secret, confirmation(docId))).json()) as {
    deleted: true;
    sockets: number;
  };

// Joins, waits a moment for the others to announce themselves, and lists them.
export const listPeers = (target: Target, docId: string, waitMs = 1000): Promise<Peer[]> =>
  withDoc(target, docId, async (client) => {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return client.peers;
  });

// Host calls. Keep the secret in your backend, never in an agent: it
// can revoke any principal.
export interface AdminTarget {
  server: string;
  // SYNC_ADMIN_SECRET of the Worker.
  secret: string;
}

async function admin(target: AdminTarget, docId: string, action: "revoke" | "role", body: object) {
  const url = new URL(target.server);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/v1/admin/docs/${encodeURIComponent(docId)}/${action}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${target.secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as { error?: { code: string } };
  if (!response.ok) {
    const closed = (result as { closed?: number }).closed;
    const note = closed === undefined ? "" : ` (${closed} sockets closed)`;
    throw new Error(`the server refused the request: ${result.error?.code ?? response.status}${note}`);
  }
  return result;
}

// Closes every socket of the principal and refuses it from now on.
export const revokePrincipal = (target: AdminTarget, docId: string, principalId: string) =>
  admin(target, docId, "revoke", { principalId }) as Promise<{ closed: number }>;

// Caps the role of a principal, also on open sockets. A null role lifts
// the cap, and with it a revoke. The role "owner" does the same, because a cap
// of owner narrows nothing.
export const setPrincipalRole = (target: AdminTarget, docId: string, principalId: string, role: Role | null) =>
  admin(target, docId, "role", { principalId, role });
