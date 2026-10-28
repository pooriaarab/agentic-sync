import { SyncClient, type Peer } from "./client/index.js";
import { readRoots } from "./core/history.js";
import type { PrincipalKind, SnapshotInfo } from "./core/types.js";

// Where to connect, and how to show up. The token is sent as a bearer
// header. The kind is a claim for presence only. The server decides who you
// are from the token.
export interface Target {
  server: string;
  token?: string;
  name?: string;
  kind?: PrincipalKind;
}

export type EditMode = "append" | "replace" | "insert";

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
    presence: { name: target.name ?? "agent", kind: target.kind ?? "agent" },
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

// Joins, waits a moment for the others to announce themselves, and lists them.
export const listPeers = (target: Target, docId: string, waitMs = 1000): Promise<Peer[]> =>
  withDoc(target, docId, async (client) => {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return client.peers;
  });
