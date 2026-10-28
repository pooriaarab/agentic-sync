import "fake-indexeddb/auto";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { SyncClient, type ConnectOptions } from "../src/client/index.js";
import { openDocument, peerLabel } from "../src/browser/index.js";
import { freePort, Proxy, startWorker, until, type Server } from "./server.js";

let server: Server;

beforeAll(async () => {
  server = await startWorker();
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

const wsUrl = (doc: string, token: string) =>
  `${server.ws}/api/v1/docs/${doc}/ws?token=${token}`;
const metaOf = async (doc: string, token = "editor") =>
  (await fetch(`${server.http}/api/v1/docs/${doc}?token=${token}`)).json() as Promise<{
    jurisdiction: string | null;
    updates: number;
    compactions: number;
    contributors: { id: string; kind: string; machine: boolean }[];
  }>;
const text = (client: SyncClient) => client.doc.getText("body").toString();
const join = (doc: string, token: string, options: Partial<ConnectOptions> = {}) =>
  SyncClient.connect({ url: wsUrl(doc, token), ...options });

describe("sync worker under wrangler dev", () => {
  test("the authorize hook refuses an unknown caller", async () => {
    expect((await fetch(`${server.http}/api/v1/docs/a?token=nobody`)).status).toBe(401);
    await expect(join("a", "nobody")).rejects.toThrow();
    expect((await fetch(`${server.http}/api/v1/docs/bad!id?token=editor`)).status).toBe(400);
  });

  test("an edit persists and a later client reads it", async () => {
    const writer = await join("persist", "editor");
    await writer.edit((doc) => doc.getText("body").insert(0, "hello"));
    await writer.disconnect();
    expect(text(await join("persist", "editor2"))).toBe("hello");
  });

  test("an edit reaches a connected client at once", async () => {
    const [a, b] = [await join("live", "editor"), await join("live", "editor2")];
    await a.edit((doc) => doc.getText("body").insert(0, "from a"));
    await until(() => text(b) === "from a", "client b to see the edit");
  });

  test("a viewer's edit is rejected and never stored", async () => {
    const [editor, viewer] = [await join("ro", "editor"), await join("ro", "viewer")];
    await viewer.edit((doc) => doc.getText("body").insert(0, "evil"));
    expect(viewer.denied).toEqual(["read-only role"]);
    await editor.edit((doc) => doc.getText("body").insert(0, "ok"));
    await until(() => text(viewer).includes("ok"), "viewer to get the editor update");
    expect(text(await join("ro", "editor2"))).toBe("ok");
    expect((await metaOf("ro")).contributors.map((c) => c.id)).toEqual(["person-1"]);
  });

  test("agent edits are labeled machine-made, also after compaction", async () => {
    const agent = await join("labels", "agent");
    for (let i = 0; i < 7; i++) await agent.edit((doc) => doc.getText("body").insert(0, `${i}`));
    const meta = await metaOf("labels");
    expect(meta.compactions).toBeGreaterThanOrEqual(1);
    expect(meta.updates).toBeLessThan(5);
    expect(meta.contributors).toEqual([{ id: "agent-7", kind: "agent_of_human", machine: true }]);
    expect(text(await join("labels", "editor"))).toBe("6543210");
  });

  test("presence shows an agent as a peer and clears on disconnect", async () => {
    const person = await join("presence", "editor");
    const counts: number[] = [];
    person.onPeers((peers) => counts.push(peers.length));
    const bot = await join("presence", "agent", { presence: { name: "Bot" } });
    await until(() => person.peers.length === 1, "presence to arrive");
    expect(person.peers[0]).toMatchObject({
      name: "Bot",
      kind: "agent_of_human",
      machine: true,
      cursor: null,
    });
    expect(peerLabel(person.peers[0])).toBe("Bot (agent_of_human, machine-made)");
    const late = await join("presence", "editor2");
    await until(() => late.peers.length === 1, "presence for a late joiner");
    await bot.disconnect();
    await until(() => person.peers.length === 0, "presence removal");
    expect(counts).toContain(1);
    expect(counts.at(-1)).toBe(0);
  });

  test("an agent that claims to be a human still shows as an agent to every peer", async () => {
    const [person, viewer] = [await join("claim", "editor"), await join("claim", "viewer")];
    const agent = await join("claim", "agent");
    // The typed option has no kind. A hostile client writes its awareness state directly.
    agent.awareness.setLocalState({ name: "Ana", kind: "human", color: "#0a0", cursor: null });
    await until(
      () => [person, viewer].every((peer) => peer.peers.some((p) => p.name === "Ana")),
      "the claim to reach both peers",
    );
    for (const peer of [person, viewer, await join("claim", "editor2")]) {
      await until(() => peer.peers.some((p) => p.name === "Ana"), "presence for every peer");
      const seen = peer.peers.find((p) => p.name === "Ana");
      expect(seen?.kind).toBe("agent_of_human");
      expect(seen?.machine).toBe(true);
      expect(peerLabel(seen!)).toBe("Ana (agent_of_human, machine-made)");
    }
    expect(agent.awareness.getLocalState()?.kind).toBe("human");
  });


  test("snapshots keep their author kind, and restore is a new update", async () => {
    const person = await join("hist", "editor");
    await person.edit((doc) => {
      doc.getText("body").insert(0, "v1");
      doc.getMap("meta").set("title", "first");
      doc.getArray("items").push(["a"]);
    });
    await person.snapshot("v1");
    await person.edit((doc) => {
      doc.getText("body").insert(2, " v2");
      doc.getMap("meta").set("title", "second");
      doc.getArray("items").push(["b"]);
    });
    await (await join("hist", "agent")).snapshot("agent-mark");
    await expect((await join("hist", "viewer")).snapshot("nope")).rejects.toThrow("403");
    const marks = (await person.snapshots()).map((s) => [s.name, s.author.kind, s.author.machine]);
    expect(marks).toEqual([["agent-mark", "agent_of_human", true], ["v1", "human", false]]);

    // This client has never named a root type, so restore must infer them.
    const fresh = await join("hist", "editor2");
    const state = (doc: Y.Doc) =>
      [doc.getText("body").toString(), doc.getMap("meta").get("title"), doc.getArray("items").toJSON()];
    await fresh.restore("v1");
    expect(state(fresh.doc)).toEqual(["v1", "first", ["a"]]);
    await until(() => text(person) === "v1", "the restore to reach a connected client");
    expect(await person.snapshots()).toHaveLength(2);
    await fresh.restore("agent-mark");
    expect(state(fresh.doc)).toEqual(["v1 v2", "second", ["a", "b"]]);
    expect((await metaOf("hist")).contributors.map((c) => c.id).sort()).toEqual(["person-1", "person-2"]);
  });

  test("offline edits persist, reconnect backs off, and edits merge", async () => {
    const port = await freePort();
    const proxy = new Proxy(port, Number(new URL(server.http).port));
    await proxy.listen();
    const url = `ws://127.0.0.1:${port}/api/v1/docs/offline/ws?token=editor`;
    const attempts: number[] = [];
    const open = (onStatus?: (status: string) => void) =>
      openDocument({ url, storageName: "e2e-offline", reconnect: { initialMs: 100, maxMs: 800 }, onStatus });
    const { client } = await open((status) => status === "connecting" && attempts.push(Date.now()));
    await client.whenSynced();
    await client.edit((doc) => doc.getText("body").insert(0, "online;"));
    const other = await join("offline", "editor2");

    await proxy.cut();
    attempts.length = 0;
    client.doc.getText("body").insert(7, "offline;");
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const gaps = attempts.slice(1).map((at, i) => at - attempts[i]);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    expect(gaps.at(-1)!).toBeGreaterThanOrEqual(gaps[0] * 1.5);

    // A reload while offline reads the edit from IndexedDB.
    const reloaded = await open();
    expect(text(reloaded.client)).toBe("online;offline;");
    await reloaded.client.disconnect();
    await reloaded.persistence.destroy();

    await other.edit((doc) => doc.getText("body").insert(0, "other;"));
    await proxy.listen();
    await until(() => text(client).includes("other;") && text(other).includes("offline;"), "the merge");
    expect(text(client)).toBe(text(other));
    expect(text(client).length).toBe("other;online;offline;".length);
    await client.disconnect();
    await proxy.cut();
  }, 60_000);

  test("the jurisdiction setting reaches the Durable Object namespace", async () => {
    expect((await metaOf("persist")).jurisdiction).toBeNull();
    // workerd cannot place objects locally. It refuses the call by name, which
    // shows the setting reached namespace.jurisdiction("eu").
    const eu = await startWorker({ SYNC_JURISDICTION: "eu" });
    try {
      expect((await fetch(`${eu.http}/api/v1/docs/a?token=editor`)).status).toBe(500);
      await until(
        () => eu.log().includes("Jurisdiction restrictions are not implemented in workerd"),
        "workerd to refuse the jurisdiction",
      );
    } finally {
      await eu.stop();
    }
  }, 120_000);

  test("two clients edit at once and converge, and a viewer is refused", async () => {
    const started = Date.now();
    const perClient = 50;
    const person = await join("converge", "editor", { presence: { name: "Ana" } });
    const agent = await join("converge", "agent", {
      headers: { authorization: "Bearer agent" },
      presence: { name: "Bot" },
    });
    const viewer = await join("converge", "viewer");
    let expectedLength = 0;
    await Promise.all(
      [person, agent].map(async (client, index) => {
        const body = client.doc.getText("body");
        for (let n = 0; n < perClient; n++) {
          const marker = `<${index}:${n}>`;
          expectedLength += marker.length;
          body.insert(Math.floor(Math.random() * (body.length + 1)), marker);
          if (n % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await client.flush();
      }),
    );
    const everyone = [person, agent, viewer];
    await until(
      () => everyone.every((client) => text(client) === text(person) && text(client).length > 0),
      "all clients to hold the same text",
    );
    // Inserts at the same time can land inside each other's marker, so the
    // check counts characters. A lost or doubled edit changes the length.
    const lengths = everyone.map((client) => text(client).length);
    expect(lengths).toEqual([expectedLength, expectedLength, expectedLength]);
    const vector = (client: SyncClient) => Buffer.from(Y.encodeStateVector(client.doc)).toString("hex");
    expect(new Set(everyone.map(vector)).size).toBe(1);

    await viewer.edit((doc) => doc.getText("body").insert(0, "VIEWER-EDIT"));
    await person.flush();
    const fresh = await join("converge", "editor2");
    const leaked = [person, agent, fresh].some((client) => text(client).includes("VIEWER-EDIT"));
    expect(viewer.denied.length).toBe(1);
    expect(leaked).toBe(false);
    await until(() => person.peers.some((peer) => peer.kind === "agent_of_human"), "agent presence");

    const meta = await metaOf("converge");
    mkdirSync("e2e-artifacts", { recursive: true });
    writeFileSync(
      "e2e-artifacts/sync-run.json",
      `${JSON.stringify(
        {
          suite: "agentic-sync two-client convergence",
          clients: [
            { role: "editor", kind: "human", edits: perClient },
            { role: "editor", kind: "agent_of_human", edits: perClient },
            { role: "viewer", kind: "human", edits: 0 },
          ],
          charactersExpected: expectedLength,
          charactersPerClient: lengths,
          converged: true,
          stateVectorsEqual: true,
          viewer: { deniedReplies: viewer.denied.length, reasons: viewer.denied, leaked },
          peersSeenByHuman: person.peers.map(({ name, kind }) => ({ name, kind })),
          contributors: meta.contributors,
          durationMs: Date.now() - started,
        },
        null,
        2,
      )}\n`,
    );
  });
});
