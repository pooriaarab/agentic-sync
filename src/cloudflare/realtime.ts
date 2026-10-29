import type { Attribution } from "../core/attribution.js";
import type { DocMeta, Grant, Principal, Realtime, Role, SnapshotInfo } from "../core/types.js";
import { DOC_HEADER, GRANT_HEADER, type SyncRoom } from "./room.js";

export const JURISDICTIONS = ["eu", "fedramp"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export function parseJurisdiction(value: string | undefined): Jurisdiction | undefined {
  if (value === undefined || value === "") return undefined;
  if (!JURISDICTIONS.includes(value as Jurisdiction)) {
    throw new Error(`SYNC_JURISDICTION must be one of: ${JURISDICTIONS.join(", ")}`);
  }
  return value as Jurisdiction;
}

// The Durable Object adapter for the Realtime port. A jurisdiction pins
// each document to that region. It is part of the object id, so set it
// before the first write and never change it for a live document.
export function createDurableObjectRealtime(
  namespace: DurableObjectNamespace,
  jurisdiction?: Jurisdiction,
): Realtime {
  const scoped = (jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace) as unknown as DurableObjectNamespace<SyncRoom>;
  const room = (docId: string) => scoped.get(scoped.idFromName(docId));
  return {
    connect(docId: string, request: Request, grant: Grant): Promise<Response> {
      const headers = new Headers(request.headers);
      headers.set(GRANT_HEADER, encodeURIComponent(JSON.stringify(grant)));
      headers.set(DOC_HEADER, docId);
      return room(docId).fetch(new Request(request, { headers }));
    },
    async meta(docId: string): Promise<DocMeta> {
      const response = await room(docId).fetch("https://room.internal/meta");
      return (await response.json()) as DocMeta;
    },
    async createSnapshot(docId: string, name: string, author: Principal) {
      const response = await room(docId).fetch("https://room.internal/snapshots", {
        method: "POST",
        body: JSON.stringify({ name, author }),
      });
      return response.status === 201 ? ((await response.json()) as SnapshotInfo) : null;
    },
    async listSnapshots(docId: string) {
      const response = await room(docId).fetch("https://room.internal/snapshots");
      return (await response.json()) as SnapshotInfo[];
    },
    async getSnapshot(docId: string, name: string) {
      const response = await room(docId).fetch(`https://room.internal/snapshots/${encodeURIComponent(name)}`);
      return response.status === 200 ? new Uint8Array(await response.arrayBuffer()) : null;
    },
    revoke: (docId: string, principalId: string) => room(docId).revoke(principalId),
    updateRole: (docId: string, principalId: string, role: Role | null) =>
      room(docId).updateRole(principalId, role),
    roleFor: (docId: string, grant: Grant) => room(docId).roleFor(grant),
    async attribution(docId: string, snapshot?: string) {
      const path = snapshot === undefined ? "attribution" : `snapshots/${encodeURIComponent(snapshot)}/attribution`;
      const response = await room(docId).fetch(`https://room.internal/${path}`);
      return response.status === 200 ? ((await response.json()) as Attribution) : null;
    },
  };
}
