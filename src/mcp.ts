import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as sdk from "./sdk.js";
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
  // Every tool joins the document, does its job, and leaves.
  const guard = async (job: (t: sdk.Target) => Promise<unknown>) => {
    try {
      return result(await job(target()));
    } catch (error) {
      return result({ error: error instanceof Error ? error.message : String(error) }, true);
    }
  };
  const read = { readOnlyHint: true };

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
    { description: "Restore a snapshot as a new edit. History stays. Text the restore brings back counts as written by you. In a text that differs in more than 600 places, the part between the shared start and end counts as written by you too.", inputSchema: { doc, name } },
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
  return server;
}

export async function startMcp(env: Record<string, string | undefined> = process.env): Promise<void> {
  await createMcpServer(env).connect(new StdioServerTransport());
}
