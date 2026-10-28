import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyncClient } from "../src/client/index.js";
import { startWorker, until, type Server } from "./server.js";

let server: Server;

beforeAll(async () => {
  if (!existsSync("dist/cli.js")) throw new Error("run npm run build first");
  server = await startWorker();
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

const env = (token: string) => ({
  ...process.env,
  AGENTIC_SYNC_URL: server.http,
  AGENTIC_SYNC_TOKEN: token,
  AGENTIC_SYNC_NAME: "e2e agent",
});

function cli(args: string[], token = "agent"): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) =>
    execFile("node", ["dist/cli.js", ...args], { env: env(token) }, (error, out, err) =>
      resolve({ code: error ? Number(error.code) : 0, out, err }),
    ),
  );
}

const json = (out: string) => JSON.parse(out) as any;

describe("the agentic-sync CLI", () => {
  test("an agent joins, edits, snapshots, and restores", async () => {
    expect((await cli(["doc", "apply", "--doc", "c1", "--root", "body", "--text", "hello"])).code).toBe(0);
    expect(json((await cli(["doc", "get", "--doc", "c1"])).out)).toEqual({ body: "hello" });
    // The server labels the author from the token, not from the --kind claim.
    const snapshot = json((await cli(["doc", "snapshot", "--doc", "c1", "--name", "s1", "--kind", "human"])).out);
    expect(snapshot.author).toMatchObject({ id: "agent-7", kind: "agent_of_human", machine: true });
    await cli(["doc", "apply", "--doc", "c1", "--root", "body", "--text", "bye", "--mode", "replace"]);
    expect(json((await cli(["doc", "get", "--doc", "c1"])).out).body).toBe("bye");
    await cli(["doc", "restore", "--doc", "c1", "--name", "s1"]);
    expect(json((await cli(["doc", "get", "--doc", "c1"])).out).body).toBe("hello");
    expect(json((await cli(["doc", "snapshot", "--doc", "c1"])).out).map((s: any) => s.name)).toEqual(["s1"]);
  });

  test("presence lists the person who is on the document", async () => {
    const person = await SyncClient.connect({
      url: `${server.ws}/api/v1/docs/c2/ws?token=editor`,
      presence: { name: "Ana", kind: "human" },
    });
    const peers = json((await cli(["doc", "presence", "--doc", "c2", "--wait", "300"])).out);
    expect(peers.map((p: any) => [p.name, p.kind, p.machine])).toEqual([["Ana", "human", false]]);
    await until(() => person.peers.length === 0, "the CLI to leave");
  });

  test("a viewer's edit fails with a non-zero exit and a reason", async () => {
    const refused = await cli(["doc", "apply", "--doc", "c1", "--root", "body", "--text", "x"], "viewer");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("read-only role");
    expect((await cli(["doc", "apply", "--doc", "c1"])).code).toBe(2);
    expect((await cli(["doc", "get", "--doc", "c1"], "nobody")).code).toBe(1);
  });
});

describe("the agentic-sync MCP server over stdio", () => {
  test("an agent edits through tools, and a viewer gets an error", async () => {
    const connect = async (token: string) => {
      const client = new Client({ name: "e2e", version: "0" });
      const stringEnv = Object.fromEntries(Object.entries(env(token)).filter(([, v]) => v !== undefined)) as Record<string, string>;
      await client.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"], env: stringEnv }));
      return client;
    };
    const call = async (client: Client, name: string, args: Record<string, unknown>) => {
      const reply = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { error: reply.isError === true, body: JSON.parse(reply.content[0].text) };
    };
    const agent = await connect("agent");
    const tools = (await agent.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["doc_apply", "doc_get", "doc_presence", "doc_restore", "doc_snapshot", "doc_snapshots"]);

    await call(agent, "doc_apply", { doc: "m1", root: "body", text: "one" });
    await call(agent, "doc_snapshot", { doc: "m1", name: "first" });
    await call(agent, "doc_apply", { doc: "m1", root: "body", text: " two" });
    expect((await call(agent, "doc_get", { doc: "m1" })).body).toEqual({ body: "one two" });
    await call(agent, "doc_restore", { doc: "m1", name: "first" });
    expect((await call(agent, "doc_get", { doc: "m1" })).body).toEqual({ body: "one" });
    expect((await call(agent, "doc_snapshots", { doc: "m1" })).body[0]).toMatchObject({ name: "first", author: { machine: true } });
    await agent.close();

    const viewer = await connect("viewer");
    const refused = await call(viewer, "doc_apply", { doc: "m1", root: "body", text: "no" });
    expect(refused.error).toBe(true);
    expect(refused.body.error).toContain("read-only role");
    await viewer.close();
  });
});
