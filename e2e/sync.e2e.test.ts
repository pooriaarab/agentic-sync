import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { SyncClient, type ConnectOptions } from "../src/client/index.js";
import { startWorker, until, type Server } from "./server.js";

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
    const bot = await join("presence", "agent", { presence: { name: "Bot" } });
    const person = await join("presence", "editor");
    await until(() => person.peers.length === 1, "presence to arrive");
    expect(person.peers[0]).toMatchObject({ name: "Bot", kind: "agent_of_human", cursor: null });
    const late = await join("presence", "editor2");
    await until(() => late.peers.length === 1, "presence for a late joiner");
    await bot.disconnect();
    await until(() => person.peers.length === 0, "presence removal");
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
    }
    expect(agent.awareness.getLocalState()?.kind).toBe("human");
  });

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
