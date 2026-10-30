import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as sdk from "./sdk.js";
import { ROLES, isPrincipalId } from "./core/types.js";
import { VERSION } from "./version.js";

const doc = z.string().describe("The document id.");
const name = z.string().describe("The snapshot name.");

const result = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true as const } : {}),
});

// Reads AGENTIC_SYNC_URL, AGENTIC_SYNC_TOKEN and AGENTIC_SYNC_NAME. A tool
// call never carries a credential. The server sets the kind from the token.
export function createMcpServer(env: Record<string, string | undefined> = process.env): McpServer {
  const server = new McpServer({ name: "agentic-realtime", version: VERSION });
  const target = (): sdk.Target => {
    if (!env.AGENTIC_SYNC_URL) throw new Error("set AGENTIC_SYNC_URL");
    return { server: env.AGENTIC_SYNC_URL, token: env.AGENTIC_SYNC_TOKEN, name: env.AGENTIC_SYNC_NAME ?? "agentic-realtime mcp" };
  };
  // Owner tools use the caller token. The Worker decides the effective role.
  const guard = async (job: (t: sdk.Target) => Promise<unknown>) => {
    try {
      return result(await job(target()));
    } catch (error) {
      return result({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  };
  const read = { readOnlyHint: true };

  server.registerTool(
    "doc_export",
    { description: "Export stored document history as a JSON array. Owners only. Holds the full export in memory.", inputSchema: { doc }, annotations: read },
    (a) => guard((t) => sdk.exportDocument(t, a.doc)),
  );
  server.registerTool(
    "doc_get",
    { description: "Read every root of a document as JSON.", inputSchema: { doc }, annotations: read },
    (a) => guard((t) => sdk.getDoc(t, a.doc)),
  );
  server.registerTool(
    "doc_apply",
    {
      description:
        "Edit a text root. Mode append (default), replace, or insert at a position. Refuses a root that is not text, such as a rich-text document.",
      inputSchema: {
        doc,
        root: z.string().describe("The name of the text root."),
        text: z.string(),
        mode: z.enum(["append", "replace", "insert"]).optional(),
        at: z.number().int().min(0).optional().describe("The position, for insert."),
      },
    },
    (a) => guard((t) => sdk.applyText(t, a.doc, a)),
  );
  server.registerTool(
    "doc_snapshot",
    { description: "Save a named snapshot of the document.", inputSchema: { doc, name } },
    (a) => guard((t) => sdk.createSnapshot(t, a.doc, a.name)),
  );
  server.registerTool(
    "doc_snapshots",
    { description: "List the named snapshots.", inputSchema: { doc }, annotations: read },
    (a) => guard((t) => sdk.listSnapshots(t, a.doc)),
  );
  server.registerTool(
    "doc_restore",
    { description: "Restore a snapshot as a new edit. History stays. Text the restore brings back counts as written by you.", inputSchema: { doc, name } },
    (a) => guard((t) => sdk.restoreSnapshot(t, a.doc, a.name)),
  );
  server.registerTool(
    "doc_blame",
    {
      description:
        "Read a text root as runs, each with the person or agent that wrote it. author is null where the log has no record. Text that a restore or an undo brought back counts as written by the one who did that. Pass snapshot to read an older version.",
      inputSchema: {
        doc,
        root: z.string().describe("The name of the text root."),
        snapshot: z.string().optional().describe("A snapshot name."),
      },
      annotations: read,
    },
    (a) => guard((t) => sdk.blame(t, a.doc, a.root, a.snapshot)),
  );
  server.registerTool(
    "doc_presence",
    { description: "List the other people and agents on the document.", inputSchema: { doc }, annotations: read },
    (a) => guard((t) => sdk.listPeers(t, a.doc)),
  );
  server.registerTool(
    "doc_delete",
    { description: "Permanently erase a document. Owners only. confirm must match doc.", inputSchema: { doc, confirm: z.string().describe("Repeat the document id to confirm permanent deletion.") }, annotations: { destructiveHint: true } },
    (a) => guard((t) => {
      if (a.confirm !== a.doc) throw new Error("CONFIRMATION_REQUIRED");
      return sdk.deleteDocument(t, a.doc);
    }),
  );
  // Host tools require explicit operator opt-in. Credentials stay in this process.
  if (env.AGENTIC_SYNC_ENABLE_ADMIN === "1") {
    const host = async (job: (client: ReturnType<typeof sdk.createAdminClient>) => Promise<unknown>) => {
      try {
        if (!env.AGENTIC_SYNC_ADMIN_SECRET) throw new Error("set AGENTIC_SYNC_ADMIN_SECRET");
        return result(await job(sdk.createAdminClient({ server: target().server, secret: env.AGENTIC_SYNC_ADMIN_SECRET })));
      } catch (error) {
        return result({ error: error instanceof Error ? error.message : String(error) }, true);
      }
    };
    const principal = z.string().refine(isPrincipalId, "Invalid principal id").describe("The principal id whose access changes.");
    server.registerTool("admin_export", {
      description: "Export stored history with host authority.", inputSchema: { doc }, annotations: read,
    }, (a) => host((c) => c.exportDocument(a.doc)));
    server.registerTool("admin_delete", {
      description: "Permanently erase with host authority. confirm must match doc.", inputSchema: { doc, confirm: z.string().describe("Repeat the document id to confirm permanent deletion.") }, annotations: { destructiveHint: true },
    }, (a) => host((c) => {
      if (a.confirm !== a.doc) throw new Error("CONFIRMATION_REQUIRED");
      return c.deleteDocument(a.doc);
    }));
    server.registerTool("admin_revoke", {
      description: "Revoke a principal with host authority.", inputSchema: { doc, principalId: principal }, annotations: { destructiveHint: true },
    }, (a) => host((c) => c.revokePrincipal(a.doc, a.principalId)));
    server.registerTool("admin_role", {
      description: "Cap a principal role. null lifts the cap or revoke.", inputSchema: { doc, principalId: principal, role: z.enum(ROLES).nullable() }, annotations: { destructiveHint: true },
    }, (a) => host((c) => c.setPrincipalRole(a.doc, a.principalId, a.role)));
  }
  return server;
}

export async function startMcp(env: Record<string, string | undefined> = process.env): Promise<void> {
  await createMcpServer(env).connect(new StdioServerTransport());
}
