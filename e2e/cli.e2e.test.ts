import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
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

describe("the agentic-realtime CLI", () => {
  test("an agent joins, edits, snapshots, and restores", async () => {
    expect((await cli(["doc", "apply", "--doc", "c1", "--root", "body", "--text", "hello"])).code).toBe(0);
    expect(json((await cli(["doc", "get", "--doc", "c1"])).out)).toEqual({ body: "hello" });
    // The server labels the author from the token. The CLI claims no kind.
    const snapshot = json((await cli(["doc", "snapshot", "--doc", "c1", "--name", "s1"])).out);
    expect(snapshot.author).toMatchObject({ id: "agent-7", kind: "agent_of_human", machine: true });
    await cli(["doc", "apply", "--doc", "c1", "--root", "body", "--text", "bye", "--mode", "replace"]);
    expect(json((await cli(["doc", "get", "--doc", "c1"])).out).body).toBe("bye");
    await cli(["doc", "restore", "--doc", "c1", "--name", "s1"]);
    expect(json((await cli(["doc", "get", "--doc", "c1"])).out).body).toBe("hello");
    expect(json((await cli(["doc", "snapshot", "--doc", "c1"])).out).map((s: any) => s.name)).toEqual(["s1"]);
  });

  test("a snapshot name that is not a safe peer name still saves and restores", async () => {
    const name = "_" + "draft-".repeat(10);
    await cli(["doc", "apply", "--doc", "c2", "--root", "body", "--text", "one"]);
    expect((await cli(["doc", "snapshot", "--doc", "c2", "--name", name])).code).toBe(0);
    await cli(["doc", "apply", "--doc", "c2", "--root", "body", "--text", "two", "--mode", "replace"]);
    expect((await cli(["doc", "restore", "--doc", "c2", "--name", name])).code).toBe(0);
    expect(json((await cli(["doc", "get", "--doc", "c2"])).out).body).toBe("one");
  });

  test("blame names the person and the agent that wrote each run", async () => {
    const person = await SyncClient.connect({ url: `${server.ws}/api/v1/docs/c3/ws?token=editor` });
    await person.edit((ydoc) => ydoc.getText("body").insert(0, "Hi "));
    await cli(["doc", "apply", "--doc", "c3", "--root", "body", "--text", "bot"]);
    const spans = json((await cli(["doc", "blame", "--doc", "c3", "--root", "body"])).out);
    expect(spans).toEqual([
      { text: "Hi ", author: { id: "person-1", kind: "human", machine: false } },
      { text: "bot", author: { id: "agent-7", kind: "agent_of_human", machine: true } },
    ]);
    expect((await cli(["doc", "blame", "--doc", "c3"])).code).toBe(2);
  });

  test("presence lists the person who is on the document", async () => {
    const person = await SyncClient.connect({
      url: `${server.ws}/api/v1/docs/c2/ws?token=editor`,
      presence: { name: "Ana" },
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

// A rich-text document: an editor root, a map root, and an array root.
async function seedRichText(doc: string): Promise<SyncClient> {
  const editor = await SyncClient.connect({ url: `${server.ws}/api/v1/docs/${doc}/ws?token=editor` });
  await editor.edit((ydoc) => {
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("hello")]);
    ydoc.getXmlFragment("default").insert(0, [paragraph]);
    ydoc.getMap("meta").set("title", "first");
    ydoc.getArray("items").push(["a"]);
  });
  return editor;
}

const snapshotOf = async (doc: string) => {
  const reader = await SyncClient.connect({ url: `${server.ws}/api/v1/docs/${doc}/ws?token=editor2` });
  const state = {
    xml: reader.doc.getXmlFragment("default").toString(),
    meta: reader.doc.getMap("meta").toJSON(),
    items: reader.doc.getArray("items").toJSON(),
  };
  await reader.disconnect();
  return state;
};

describe("doc apply on a root that is not text", () => {
  test("the CLI refuses a mismatched root and leaves the document alone", async () => {
    const owner = await seedRichText("r1");
    const before = await snapshotOf("r1");
    expect(before.xml).toContain("hello");
    for (const [root, mode] of [
      ["default", "replace"],
      ["default", "append"],
      ["default", "insert"],
      ["meta", "replace"],
      ["items", "append"],
    ]) {
      const refused = await cli(["doc", "apply", "--doc", "r1", "--root", root, "--text", "x", "--mode", mode]);
      expect(refused.code, `${root} ${mode}`).toBe(1);
      expect(refused.err).toContain(`root "${root}"`);
      expect(refused.err).toContain("not text");
    }
    expect(await snapshotOf("r1")).toEqual(before);
    // A new root and a text root still take an edit.
    expect((await cli(["doc", "apply", "--doc", "r1", "--root", "notes", "--text", "n"])).code).toBe(0);
    expect(json((await cli(["doc", "get", "--doc", "r1"])).out)).toMatchObject({ notes: "n" });
    await owner.disconnect();
  });

  test("the MCP tool refuses a mismatched root with a clear error", async () => {
    const owner = await seedRichText("r2");
    const before = await snapshotOf("r2");
    const client = new Client({ name: "e2e", version: "0" });
    const stringEnv = Object.fromEntries(Object.entries(env("agent")).filter(([, v]) => v !== undefined)) as Record<string, string>;
    await client.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"], env: stringEnv }));
    const reply = (await client.callTool({
      name: "doc_apply",
      arguments: { doc: "r2", root: "default", text: "x", mode: "replace" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(reply.isError).toBe(true);
    expect(JSON.parse(reply.content[0].text).error).toContain('root "default" is not text');
    await client.close();
    expect(await snapshotOf("r2")).toEqual(before);
    await owner.disconnect();
  });
});

describe("the CLI checks its flags", () => {
  test("a bad flag value exits 2 and sends nothing", async () => {
    const base = ["doc", "apply", "--doc", "f1", "--root", "body"];
    const cases: [string[], string][] = [
      [["--text", "x", "--mode", "repalce"], "--mode"],
      [["--text", "x", "--mode", "insert", "--at", "abc"], "--at"],
      [["--text", "x", "--mode", "insert", "--at", "-1"], "--at"],
      [["--text", "x", "--mode", "insert", "--at", "1.5"], "--at"],
      [["--text", "--mode", "append"], "--text"],
    ];
    for (const [extra, flag] of cases) {
      const run = await cli([...base, ...extra]);
      expect(run.code, extra.join(" ")).toBe(2);
      expect(run.err).toContain(flag);
    }
    expect(json((await cli(["doc", "get", "--doc", "f1"])).out)).toEqual({});
  });

  test("the CLI has no --kind flag, because the server sets the kind", async () => {
    const run = await cli(["doc", "get", "--doc", "f2", "--kind", "human"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("--kind");
  });
});

describe("the agentic-realtime MCP server over stdio", () => {
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
    expect(tools).toEqual(["doc_apply", "doc_blame", "doc_get", "doc_presence", "doc_restore", "doc_snapshot", "doc_snapshots"]);

    await call(agent, "doc_apply", { doc: "m1", root: "body", text: "one" });
    await call(agent, "doc_snapshot", { doc: "m1", name: "first" });
    await call(agent, "doc_apply", { doc: "m1", root: "body", text: " two" });
    expect((await call(agent, "doc_get", { doc: "m1" })).body).toEqual({ body: "one two" });
    await call(agent, "doc_restore", { doc: "m1", name: "first" });
    expect((await call(agent, "doc_get", { doc: "m1" })).body).toEqual({ body: "one" });
    expect((await call(agent, "doc_snapshots", { doc: "m1" })).body[0]).toMatchObject({ name: "first", author: { machine: true } });
    const blamed = (await call(agent, "doc_blame", { doc: "m1", root: "body" })).body;
    expect(blamed.length).toBeGreaterThan(0);
    expect(blamed.every((span: any) => span.author.machine === true)).toBe(true);
    await agent.close();

    const viewer = await connect("viewer");
    const refused = await call(viewer, "doc_apply", { doc: "m1", root: "body", text: "no" });
    expect(refused.error).toBe(true);
    expect(refused.body.error).toContain("read-only role");
    await viewer.close();
  });
});
