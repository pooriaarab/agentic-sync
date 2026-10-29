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
  const log = await getAttribution(target, docId, snapshot);
  if (snapshot !== undefined) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(await (await read(target, docId, `snapshots/${encodeURIComponent(snapshot)}`)).arrayBuffer()));
    assertTextRootOf(doc, root);
    return blameText(doc, root, log);
  }
  return withDoc(target, docId, async (client) => {
    assertTextRootOf(client.doc, root);
    return blameText(client.doc, root, log);
  });
}

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
