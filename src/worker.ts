import { Hono } from "hono";
import { assertAdminSecret, matchesSecret } from "./cloudflare/admin.js";
import {
  createDurableObjectRealtime,
  parseJurisdiction,
} from "./cloudflare/realtime.js";
import {
  assertGrant,
  canWrite,
  DOC_ID_PATTERN,
  MAX_PRINCIPAL_ID_LENGTH,
  ROLES,
  SNAPSHOT_NAME_PATTERN,
  type Authorize,
} from "./core/types.js";

export { assertGrant, ROLES } from "./core/types.js";
export type { Authorize, Grant, Principal, Role } from "./core/types.js";
export { SyncRoom, createSyncRoom } from "./cloudflare/room.js";
export type { Reauthorize } from "./cloudflare/room.js";
export { createDurableObjectRealtime } from "./cloudflare/realtime.js";
export type { Jurisdiction } from "./cloudflare/realtime.js";

export interface SyncEnv {
  SYNC_ROOM: DurableObjectNamespace;
  // "eu" or "fedramp". Unset means no jurisdiction.
  SYNC_JURISDICTION?: string;
  // Updates between snapshot compactions. Default 50, at most 128.
  SYNC_COMPACT_EVERY?: string;
  // Seconds between re-authorizations of open sockets. Default 60.
  SYNC_REAUTH_INTERVAL_SECONDS?: string;
  // Ranges the attribution log keeps, 4 to 5000. Default 4000.
  SYNC_ATTRIBUTION_MAX_RANGES?: string;
  // Bearer secret for /api/v1/admin. At least 32 bytes. Unset turns admin off.
  SYNC_ADMIN_SECRET?: string;
}

export interface SyncWorkerOptions {
  authorize: Authorize;
}

const refused = (status: number, code: string): Response =>
  Response.json({ error: { code } }, { status });

const validPrincipalId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PRINCIPAL_ID_LENGTH;

const realtimeFor = (env: SyncEnv) =>
  createDurableObjectRealtime(env.SYNC_ROOM, parseJurisdiction(env.SYNC_JURISDICTION));

let warnedAdminOff = false;

// Null when the caller holds the host secret.
async function denyUnlessAdmin(request: Request, env: SyncEnv): Promise<Response | null> {
  let secret: string;
  try {
    secret = assertAdminSecret(env.SYNC_ADMIN_SECRET);
  } catch (error) {
    if (!warnedAdminOff) console.error((error as Error).message);
    warnedAdminOff = true;
    return refused(503, "ADMIN_DISABLED");
  }
  const given = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  return (await matchesSecret(given, secret)) ? null : refused(401, "UNAUTHORIZED");
}

export function createSyncWorker(options: SyncWorkerOptions): ExportedHandler<SyncEnv> {
  const app = new Hono<{ Bindings: SyncEnv }>();

  app.get("/health", (c) => c.json({ ok: true, pack: "agentic-realtime" }));

  // Checks the document id, then asks the host who the caller is.
  const open = async (request: Request, env: SyncEnv, id: string) => {
    if (!DOC_ID_PATTERN.test(id)) return refused(400, "INVALID_DOC_ID");
    const granted = await options.authorize(request, id, env as unknown as Record<string, unknown>);
    if (granted === null) return refused(401, "UNAUTHORIZED");
    const realtime = realtimeFor(env);
    const checked = assertGrant(granted);
    // The host may have capped this principal since the grant was minted.
    const role = await realtime.roleFor(id, checked);
    if (role === null) return refused(403, "ACCESS_REVOKED");
    const grant = { ...checked, role };
    return { grant, jurisdiction: parseJurisdiction(env.SYNC_JURISDICTION), realtime };
  };

  app.get("/api/v1/docs/:id", async (c) => {
    const id = c.req.param("id");
    const opened = await open(c.req.raw, c.env, id);
    if (opened instanceof Response) return opened;
    const meta = await opened.realtime.meta(id);
    return c.json({ id, jurisdiction: opened.jurisdiction ?? null, role: opened.grant.role, ...meta });
  });

  app.get("/api/v1/docs/:id/snapshots", async (c) => {
    const opened = await open(c.req.raw, c.env, c.req.param("id"));
    if (opened instanceof Response) return opened;
    return c.json(await opened.realtime.listSnapshots(c.req.param("id")));
  });

  app.post("/api/v1/docs/:id/snapshots", async (c) => {
    const id = c.req.param("id");
    const opened = await open(c.req.raw, c.env, id);
    if (opened instanceof Response) return opened;
    if (!canWrite(opened.grant.role)) return refused(403, "READ_ONLY_ROLE");
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    if (typeof body?.name !== "string" || !SNAPSHOT_NAME_PATTERN.test(body.name)) {
      return refused(400, "INVALID_SNAPSHOT_NAME");
    }
    const made = await opened.realtime.createSnapshot(id, body.name, opened.grant.principal);
    if (made) return c.json(made, 201);
    // The room also refuses a principal that was capped after open() ran.
    const now = await opened.realtime.roleFor(id, opened.grant);
    if (now === null) return refused(403, "ACCESS_REVOKED");
    return canWrite(now) ? refused(409, "SNAPSHOT_EXISTS_OR_LIMIT") : refused(403, "READ_ONLY_ROLE");
  });

  app.get("/api/v1/docs/:id/snapshots/:name", async (c) => {
    const opened = await open(c.req.raw, c.env, c.req.param("id"));
    if (opened instanceof Response) return opened;
    const name = c.req.param("name");
    const state = SNAPSHOT_NAME_PATTERN.test(name)
      ? await opened.realtime.getSnapshot(c.req.param("id"), name)
      : null;
    if (state === null) return refused(404, "NOT_FOUND");
    return new Response(new Uint8Array(state), { headers: { "content-type": "application/octet-stream" } });
  });

  app.get("/api/v1/docs/:id/attribution", async (c) => {
    const id = c.req.param("id");
    const opened = await open(c.req.raw, c.env, id);
    if (opened instanceof Response) return opened;
    return c.json(await opened.realtime.attribution(id));
  });

  app.get("/api/v1/docs/:id/snapshots/:name/attribution", async (c) => {
    const id = c.req.param("id");
    const opened = await open(c.req.raw, c.env, id);
    if (opened instanceof Response) return opened;
    const name = c.req.param("name");
    const log = SNAPSHOT_NAME_PATTERN.test(name) ? await opened.realtime.attribution(id, name) : null;
    return log === null ? refused(404, "NOT_FOUND") : c.json(log);
  });

  app.get("/api/v1/docs/:id/ws", async (c) => {
    if (c.req.header("upgrade") !== "websocket") return refused(426, "UPGRADE_REQUIRED");
    const id = c.req.param("id");
    const opened = await open(c.req.raw, c.env, id);
    if (opened instanceof Response) return opened;
    return opened.realtime.connect(id, c.req.raw, opened.grant);
  });

  // Host calls. Only a caller with SYNC_ADMIN_SECRET gets in.
  app.post("/api/v1/admin/docs/:id/revoke", async (c) => {
    const denied = await denyUnlessAdmin(c.req.raw, c.env);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!DOC_ID_PATTERN.test(id)) return refused(400, "INVALID_DOC_ID");
    const body = (await c.req.json().catch(() => null)) as { principalId?: unknown } | null;
    if (!validPrincipalId(body?.principalId)) return refused(400, "INVALID_PRINCIPAL_ID");
    const { closed, stored } = await realtimeFor(c.env).revoke(id, body.principalId);
    // The sockets are closed either way. Without a stored ban the principal can return.
    return stored ? c.json({ closed }) : Response.json({ error: { code: "CAP_LIMIT" }, closed }, { status: 409 });
  });

  app.post("/api/v1/admin/docs/:id/role", async (c) => {
    const denied = await denyUnlessAdmin(c.req.raw, c.env);
    if (denied) return denied;
    const id = c.req.param("id");
    if (!DOC_ID_PATTERN.test(id)) return refused(400, "INVALID_DOC_ID");
    const body = (await c.req.json().catch(() => null)) as
      | { principalId?: unknown; role?: unknown }
      | null;
    if (!validPrincipalId(body?.principalId)) return refused(400, "INVALID_PRINCIPAL_ID");
    const role = body.role;
    if (role !== null && !ROLES.includes(role as (typeof ROLES)[number])) return refused(400, "INVALID_ROLE");
    const stored = await realtimeFor(c.env).updateRole(id, body.principalId, role as (typeof ROLES)[number] | null);
    return stored ? c.json({ ok: true }) : refused(409, "CAP_LIMIT");
  });

  app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));

  return { fetch: app.fetch };
}

// A worker with no way to sign in refuses every document. A host
// builds its own with createSyncWorker and an authorize hook.
export default createSyncWorker({ authorize: () => null });
