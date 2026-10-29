import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { SyncClient, type ConnectOptions, type Peer } from "../client/index.js";

export interface OpenedDocument {
  client: SyncClient;
  persistence: IndexeddbPersistence;
  // Removes the page listeners that feed the away tracker. A no-op without `away`.
  stopWatching: () => void;
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
  const stopWatching = options.away ? watchPageAway(client) : () => {};
  return { client, persistence, stopWatching };
}

// A line for a screen reader or a tooltip. The server stamps the kind from
// the grant, so an agent always reads as one.
export function peerLabel(peer: Peer): string {
  return peer.machine ? `${peer.name} (${peer.kind}, machine-made)` : peer.name;
}

// The events that count as activity on a page.
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;

// The parts of `document` that the page watcher reads. A test passes a stand-in.
export interface PageLike {
  readonly hidden: boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

// Feeds a client's away tracker from the page: input counts as activity,
// and a hidden tab reports "hidden". The client needs the `away` option.
// Returns a function that removes the listeners.
export function watchPageAway(client: SyncClient, page: PageLike = document): () => void {
  const active = () => client.markActive();
  const visibility = () => client.setHidden(page.hidden);
  for (const type of ACTIVITY_EVENTS) page.addEventListener(type, active);
  page.addEventListener("visibilitychange", visibility);
  visibility();
  return () => {
    for (const type of ACTIVITY_EVENTS) page.removeEventListener(type, active);
    page.removeEventListener("visibilitychange", visibility);
  };
}
