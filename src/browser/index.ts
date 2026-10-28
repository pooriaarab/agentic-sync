import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { SyncClient, type ConnectOptions, type Peer } from "../client/index.js";

export interface OpenedDocument {
  client: SyncClient;
  persistence: IndexeddbPersistence;
}

// Opens a document that survives a reload and a lost connection. It loads
// the IndexedDB copy first, so text shows before the network answers.
export async function openDocument(
  options: Omit<ConnectOptions, "doc"> & { storageName: string },
): Promise<OpenedDocument> {
  const doc = new Y.Doc();
  const persistence = new IndexeddbPersistence(options.storageName, doc);
  await persistence.whenSynced;
  const client = SyncClient.open({ reconnect: {}, ...options, doc });
  return { client, persistence };
}

// A line for a screen reader or a tooltip. The server stamps the kind from
// the grant, so an agent always reads as one.
export function peerLabel(peer: Peer): string {
  return peer.machine ? `${peer.name} (${peer.kind}, machine-made)` : peer.name;
}
