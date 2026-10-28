import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Peer, until } from "./peer.js";
import { startWorker, type Server } from "./server.js";

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
const text = (peer: Peer) => peer.doc.getText("body").toString();

async function join(doc: string, token: string): Promise<Peer> {
  const peer = new Peer(wsUrl(doc, token));
  await peer.synced;
  return peer;
}

describe("sync worker under wrangler dev", () => {
  test("the authorize hook refuses an unknown caller", async () => {
    expect((await fetch(`${server.http}/api/v1/docs/a?token=nobody`)).status).toBe(401);
    await expect(new Peer(wsUrl("a", "nobody")).synced).rejects.toThrow();
    expect((await fetch(`${server.http}/api/v1/docs/bad!id?token=editor`)).status).toBe(400);
  });

  test("an edit persists and a later peer reads it", async () => {
    const writer = await join("persist", "editor");
    writer.doc.getText("body").insert(0, "hello");
    await until(async () => (await metaOf("persist")).updates === 1, "the update to persist");
    writer.close();
    const reader = await join("persist", "editor2");
    expect(text(reader)).toBe("hello");
  });

  test("an edit reaches a connected peer at once", async () => {
    const [a, b] = [await join("live", "editor"), await join("live", "editor2")];
    a.doc.getText("body").insert(0, "from a");
    await until(() => text(b) === "from a", "peer b to see the edit");
  });

  test("a viewer's edit is rejected and never stored", async () => {
    const [editor, viewer] = [await join("ro", "editor"), await join("ro", "viewer")];
    viewer.doc.getText("body").insert(0, "evil");
    await until(() => viewer.denied.length > 0, "the permission-denied reply");
    editor.doc.getText("body").insert(0, "ok");
    await until(() => text(viewer).includes("ok"), "viewer to get the editor update");
    const late = await join("ro", "editor2");
    expect(text(late)).toBe("ok");
    expect((await metaOf("ro")).contributors.map((c) => c.id)).toEqual(["person-1"]);
  });

  test("agent edits are labeled machine-made, also after compaction", async () => {
    const agent = await join("labels", "agent");
    for (let i = 0; i < 7; i++) agent.doc.getText("body").insert(0, `${i}`);
    await until(async () => (await metaOf("labels")).compactions >= 1, "a compaction");
    const meta = await metaOf("labels");
    expect(meta.contributors).toEqual([{ id: "agent-7", kind: "agent_of_human", machine: true }]);
    expect(meta.updates).toBeLessThan(5);
    const late = await join("labels", "editor");
    expect(text(late)).toBe("6543210");
  });

  test("presence reaches peers and clears on disconnect", async () => {
    const [a, b] = [await join("presence", "agent"), await join("presence", "editor")];
    a.setPresence(11, 1, { name: "bot", kind: "agent", color: "#0a0", cursor: null });
    await until(() => b.awareness.some((e) => e.id === 11), "presence to arrive");
    const late = await join("presence", "editor2");
    await until(() => late.awareness.some((e) => e.id === 11), "presence for a late joiner");
    a.close();
    await until(
      () => b.awareness.some((e) => e.id === 11 && e.state === "null"),
      "presence removal",
    );
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
});
