import { Hono } from "hono";
import {
  createDurableObjectRealtime,
  parseJurisdiction,
} from "./cloudflare/realtime.js";
import { assertGrant, DOC_ID_PATTERN, type Authorize } from "./core/types.js";

export { SyncRoom } from "./cloudflare/room.js";
export { createDurableObjectRealtime } from "./cloudflare/realtime.js";
export type { Jurisdiction } from "./cloudflare/realtime.js";

export interface SyncEnv {
  SYNC_ROOM: DurableObjectNamespace;
  // "eu" or "fedramp". Unset means no jurisdiction.
  SYNC_JURISDICTION?: string;
  // Updates between snapshot compactions. Default 50, at most 128.
  SYNC_COMPACT_EVERY?: string;
}

export interface SyncWorkerOptions {
  authorize: Authorize;
}

const refused = (status: number, code: string): Response =>
  Response.json({ error: { code } }, { status });

export function createSyncWorker(options: SyncWorkerOptions): ExportedHandler<SyncEnv> {
  const app = new Hono<{ Bindings: SyncEnv }>();

  app.get("/health", (c) => c.json({ ok: true, pack: "agentic-sync" }));

  // Checks the document id, then asks the host who the caller is.
  const open = async (request: Request, env: SyncEnv, id: string) => {
    if (!DOC_ID_PATTERN.test(id)) return refused(400, "INVALID_DOC_ID");
    const granted = await options.authorize(request, id);
    if (granted === null) return refused(401, "UNAUTHORIZED");
    const grant = assertGrant(granted);
    const jurisdiction = parseJurisdiction(env.SYNC_JURISDICTION);
    return { grant, jurisdiction, realtime: createDurableObjectRealtime(env.SYNC_ROOM, jurisdiction) };
  };

  app.get("/api/v1/docs/:id", async (c) => {
    const id = c.req.param("id");
    const opened = await open(c.req.raw, c.env, id);
    if (opened instanceof Response) return opened;
    const meta = await opened.realtime.meta(id);
    return c.json({ id, jurisdiction: opened.jurisdiction ?? null, role: opened.grant.role, ...meta });
  });

  app.get("/api/v1/docs/:id/ws", async (c) => {
    if (c.req.header("upgrade") !== "websocket") return refused(426, "UPGRADE_REQUIRED");
    const id = c.req.param("id");
    const opened = await open(c.req.raw, c.env, id);
    if (opened instanceof Response) return opened;
    return opened.realtime.connect(id, c.req.raw, opened.grant);
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));

  return { fetch: app.fetch };
}

// A worker with no way to sign in refuses every document. A host
// builds its own with createSyncWorker and an authorize hook.
export default createSyncWorker({ authorize: () => null });
