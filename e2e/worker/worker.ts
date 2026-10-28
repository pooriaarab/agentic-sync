import { createSyncWorker } from "../../src/worker.js";
import type { Grant } from "../../src/core/types.js";

export { SyncRoom } from "../../src/worker.js";

// Test only. A real host reads a session or an API key instead.
const TOKENS: Record<string, Grant> = {
  editor: { principal: { id: "person-1", kind: "human" }, role: "editor" },
  editor2: { principal: { id: "person-2", kind: "human" }, role: "owner" },
  agent: { principal: { id: "agent-7", kind: "agent_of_human" }, role: "editor" },
  viewer: { principal: { id: "person-3", kind: "human" }, role: "viewer" },
};

export default createSyncWorker({
  authorize: (request) => TOKENS[new URL(request.url).searchParams.get("token") ?? ""] ?? null,
});
