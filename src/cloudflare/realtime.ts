import type { DocMeta, Grant, Realtime } from "../core/types.js";
import { GRANT_HEADER } from "./room.js";

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
  const scoped = jurisdiction ? namespace.jurisdiction(jurisdiction) : namespace;
  const room = (docId: string) => scoped.get(scoped.idFromName(docId));
  return {
    connect(docId: string, request: Request, grant: Grant): Promise<Response> {
      const headers = new Headers(request.headers);
      headers.set(GRANT_HEADER, encodeURIComponent(JSON.stringify(grant)));
      return room(docId).fetch(new Request(request, { headers }));
    },
    async meta(docId: string): Promise<DocMeta> {
      const response = await room(docId).fetch("https://room.internal/meta");
      return (await response.json()) as DocMeta;
    },
  };
}
