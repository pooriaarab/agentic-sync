import { createDurableObjectRealtime, createSyncRoom, createSyncWorker, type SyncEnv } from "../../src/worker.js";
import type { Grant, Role } from "../../src/core/types.js";

// Test only. A real host reads a session or an API key instead.
const TOKENS: Record<string, Grant> = {
  editor: { principal: { id: "person-1", kind: "human" }, role: "editor" },
  editor2: { principal: { id: "person-2", kind: "human" }, role: "owner" },
  agent: { principal: { id: "agent-7", kind: "agent_of_human" }, role: "editor" },
  named: { principal: { id: "person-9", kind: "human" }, role: "editor", name: "Ana" },
  hostile: { principal: { id: "person-10", kind: "human" }, role: "editor", name: "Ana\u202Eevil" },
  viewer: { principal: { id: "person-3", kind: "human" }, role: "viewer" },
};

// Test only. "user-N" is a distinct editor, for tests that need many principals.
function grantFor(token: string): Grant | null {
  if (/^user-\d+$/.test(token)) return { principal: { id: token, kind: "human" }, role: "editor" };
  return TOKENS[token] ?? null;
}

// Test only. With ROLE_FEED_URL set, the test process answers for the host
// directory: GET <url>/<principal id> returns { role }. Without it, the
// role in the token table stands.
export const SyncRoom = createSyncRoom({
  reauthorize: async (principal, _docId, env) => {
    const feed = env.ROLE_FEED_URL as string | undefined;
    if (feed === undefined) {
      if (/^user-\d+$/.test(principal.id)) return "editor";
      return Object.values(TOKENS).find((grant) => grant.principal.id === principal.id)?.role ?? null;
    }
    const response = await fetch(`${feed}/${encodeURIComponent(principal.id)}`);
    return response.ok ? ((await response.json()) as { role: Role | null }).role : null;
  },
});

const worker = createSyncWorker({
  authorize: (request) => {
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    return grantFor(bearer ?? new URL(request.url).searchParams.get("token") ?? "");
  },
});

// Test only. Calls the Realtime port with no Worker role check, as a host
// Worker that skips the check would.
export default {
  async fetch(request: Request, env: SyncEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const direct = /^\/test\/direct-snapshot\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (direct === null) return worker.fetch!(request as never, env, ctx);
    const made = await createDurableObjectRealtime(env.SYNC_ROOM).createSnapshot(
      direct[1],
      searchParams.get("name") ?? "",
      TOKENS.editor.principal,
    );
    return new Response(null, { status: made === null ? 409 : 201 });
  },
};
