import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { SyncClient } from "../src/client/index.js";
import { updateMessage } from "../src/core/protocol.js";
import { blame, getAttribution, type Target } from "../src/sdk.js";
import { Peer } from "./peer.js";
import { startWorker, until, type Server } from "./server.js";

const HUMAN = { id: "person-1", kind: "human", machine: false };
const AGENT = { id: "agent-7", kind: "agent_of_human", machine: true };

let server: Server;
let capped: Server;
const stopped: Server[] = [];

beforeAll(async () => {
  server = await startWorker();
  capped = await startWorker({ SYNC_ATTRIBUTION_MAX_RANGES: "6" });
}, 180_000);

afterAll(async () => {
  await Promise.all([...stopped, server, capped].map((s) => s?.stop()));
});

const target = (s: Server, token: string): Target => ({ server: s.http, token });
const join = (s: Server, doc: string, token: string) =>
  SyncClient.connect({ url: `${s.ws}/api/v1/docs/${doc}/ws?token=${token}` });
const text = (client: SyncClient) => client.doc.getText("body").toString();
const append = (client: SyncClient, piece: string) =>
  client.edit((doc) => doc.getText("body").insert(doc.getText("body").length, piece));
const compactions = async (s: Server, doc: string) =>
  ((await (await fetch(`${s.http}/api/v1/docs/${doc}?token=editor`)).json()) as { compactions: number })
    .compactions;

// One writer at a time, so the order of the text is the order of the calls.
async function writeAlternating(s: Server, doc: string, count: number) {
  const [human, agent] = [await join(s, doc, "editor"), await join(s, doc, "agent")];
  for (let i = 0; i < count; i++) {
    const [writer, reader] = i % 2 === 0 ? [human, agent] : [agent, human];
    await append(writer, String(i % 10));
    await until(() => text(reader) === text(writer), "the other client to see the edit");
  }
}

const alternating = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ text: String(i % 10), author: i % 2 === 0 ? HUMAN : AGENT }));

describe("who wrote what, under wrangler dev", () => {
  test("every run of text keeps its author after compaction", async () => {
    await writeAlternating(server, "blame", 12);
    expect(await compactions(server, "blame")).toBeGreaterThanOrEqual(2);
    expect(await blame(target(server, "viewer"), "blame", "body")).toEqual(alternating(12));

    const log = await getAttribution(target(server, "viewer"), "blame");
    expect(log.authors).toEqual([HUMAN, AGENT]);
    // One client writes a contiguous run, so each author holds one range.
    expect(log.ranges.map((range) => range.length)).toEqual([6, 6]);
    expect(log.dropped).toBe(0);
  });

  test("a stranger cannot read the log", async () => {
    expect((await fetch(`${server.http}/api/v1/docs/blame/attribution?token=nobody`)).status).toBe(401);
  });

  test("a snapshot keeps the log as it was, and later writers stay out", async () => {
    const human = await join(server, "early", "editor");
    await append(human, "a");
    await human.snapshot("v1");
    const agent = await join(server, "early", "agent");
    await append(agent, "b");

    const early = target(server, "viewer");
    expect(await blame(early, "early", "body", "v1")).toEqual([{ text: "a", author: HUMAN }]);
    expect((await blame(early, "early", "body")).map((span) => span.author)).toEqual([HUMAN, AGENT]);
    expect((await getAttribution(early, "early", "v1")).authors).toEqual([HUMAN]);
    await expect(blame(early, "early", "body", "missing")).rejects.toThrow();
  });

  test("the log survives a restart of the server", async () => {
    const first = await startWorker();
    await writeAlternating(first, "kept", 7);
    await first.stop();
    const second = await startWorker({}, first.persist);
    stopped.push(second);
    expect(await blame(target(second, "viewer"), "kept", "body")).toEqual(alternating(7));
  }, 120_000);

  test("past the limit the oldest runs show as unattributed", async () => {
    // A new client id per write gives one range per write.
    for (let i = 0; i < 10; i++) {
      const writer = await join(capped, "capped", i % 2 === 0 ? "editor" : "agent");
      await append(writer, String(i));
      await writer.disconnect();
    }
    const log = await getAttribution(target(capped, "viewer"), "capped");
    expect(log.ranges).toHaveLength(6);
    expect(log.dropped).toBe(4);
    expect(await blame(target(capped, "viewer"), "capped", "body")).toEqual([
      { text: "0123", author: null },
      ...Array.from({ length: 6 }, (_, k) => ({ text: String(k + 4), author: (k + 4) % 2 === 0 ? HUMAN : AGENT })),
    ]);
  });

  // A copy of the client's document that writes under the client's own id.
  const impostor = (victim: SyncClient) => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(victim.doc));
    copy.clientID = victim.doc.clientID;
    return copy;
  };

  test("an update held back for missing content cannot borrow the next writer's name", async () => {
    const person = await join(server, "held", "editor");
    await append(person, "Hi ");
    const bot = new Peer(`${server.ws}/api/v1/docs/held/ws?token=agent`);
    await bot.synced;
    let code: number | undefined;
    void bot.closed.then((value) => (code = value));
    // The bot's item points at the id the person will use next. The room
    // has no such id, so Yjs holds the item until the person writes it.
    const ghost = impostor(person);
    ghost.getText("body").insert(3, "Z");
    const accomplice = new Y.Doc();
    Y.applyUpdate(accomplice, Y.encodeStateAsUpdate(ghost));
    let held: Uint8Array | undefined;
    accomplice.on("update", (update: Uint8Array) => (held = update));
    accomplice.getText("body").insert(4, "BOT");
    bot.sendRaw(updateMessage(held!));
    await until(() => code !== undefined, "the room to refuse the held update");
    expect(code).toBe(1008);

    await append(person, "!");
    expect(await blame(target(server, "viewer"), "held", "body")).toEqual([{ text: "Hi !", author: HUMAN }]);
  });

  test("a sender cannot write under the client id of another principal", async () => {
    const person = await join(server, "claim", "editor");
    await append(person, "Hi ");
    const bot = new Peer(`${server.ws}/api/v1/docs/claim/ws?token=agent`);
    await bot.synced;
    const forged = impostor(person);
    let update: Uint8Array | undefined;
    forged.on("update", (u: Uint8Array) => (update = u));
    forged.getText("body").insert(3, "BOT");
    bot.sendRaw(updateMessage(update!));
    await until(() => bot.denied.length > 0, "the room to refuse the update");
    expect(bot.denied).toEqual(["client id belongs to another principal"]);
    expect(await blame(target(server, "viewer"), "claim", "body")).toEqual([{ text: "Hi ", author: HUMAN }]);
  });

  test("a restore keeps the authors of the text it leaves alone", async () => {
    const agent = await join(server, "restore", "agent");
    await append(agent, "bot");
    const person = await join(server, "restore", "editor");
    await until(() => text(person) === "bot", "the agent's text to arrive");
    await append(person, " ok");
    await person.snapshot("v1");
    await append(person, "!");
    await person.restore("v1");
    expect(text(person)).toBe("bot ok");
    expect(await blame(target(server, "viewer"), "restore", "body")).toEqual([
      { text: "bot", author: AGENT },
      { text: " ok", author: HUMAN },
    ]);
  });

  test("a restore keeps the authors of rich text, and its formatting", async () => {
    const agent = await join(server, "rich", "agent");
    await agent.edit((doc) => {
      const body = doc.getText("body");
      body.insert(0, "bot text ");
      body.insert(9, "bold", { bold: true });
    });
    const person = await join(server, "rich", "editor");
    await until(() => text(person) === "bot text bold", "the agent's text to arrive");
    await person.snapshot("v1");
    await append(person, "!");
    await person.restore("v1");
    expect(person.doc.getText("body").toDelta()).toEqual([
      { insert: "bot text " },
      { insert: "bold", attributes: { bold: true } },
    ]);
    expect(await blame(target(server, "viewer"), "rich", "body")).toEqual([{ text: "bot text bold", author: AGENT }]);
  });

  test("an author who only deletes owns no range and is not listed", async () => {
    const agent = await join(server, "deleter", "agent");
    await append(agent, "x");
    const person = await join(server, "deleter", "editor");
    await until(() => text(person) === "x", "the agent's text to arrive");
    await person.edit((doc) => doc.getText("body").delete(0, 1));
    expect((await getAttribution(target(server, "viewer"), "deleter")).authors).toEqual([AGENT]);
  });

  test("a restore that only removes formatting keeps the authors", async () => {
    const agent = await join(server, "format", "agent");
    await append(agent, "agent paragraph");
    const person = await join(server, "format", "editor");
    await until(() => text(person) === "agent paragraph", "the agent's text to arrive");
    await person.snapshot("plain");
    await person.edit((doc) => doc.getText("body").format(0, 15, { bold: true }));
    await person.restore("plain");
    expect(person.doc.getText("body").toDelta()).toEqual([{ insert: "agent paragraph" }]);
    expect(await blame(target(server, "viewer"), "format", "body")).toEqual([{ text: "agent paragraph", author: AGENT }]);
  });

  test("a restore brings back an embedded type without a throw", async () => {
    const person = await join(server, "embed", "editor");
    await person.edit((doc) => {
      const body = doc.getText("body");
      body.insert(0, "x");
      body.insertEmbed(1, new Y.Map([["k", "v"]]));
    });
    await person.snapshot("with-embed");
    await person.edit((doc) => doc.getText("body").delete(0, 2));
    await person.restore("with-embed");
    const [first, second] = person.doc.getText("body").toDelta() as { insert: string | Y.Map<string> }[];
    expect(first.insert).toBe("x");
    expect((second.insert as Y.Map<string>).toJSON()).toEqual({ k: "v" });
  });

  test("a restore after edits at both ends keeps the authors of the middle", async () => {
    const agent = await join(server, "ends", "agent");
    await append(agent, "agent paragraph");
    const person = await join(server, "ends", "editor");
    await until(() => text(person) === "agent paragraph", "the agent's text to arrive");
    await person.snapshot("before");
    await person.edit((doc) => {
      const body = doc.getText("body");
      body.insert(0, "X");
      body.insert(body.length, "Y");
    });
    await person.restore("before");
    expect(text(person)).toBe("agent paragraph");
    expect(await blame(target(server, "viewer"), "ends", "body")).toEqual([{ text: "agent paragraph", author: AGENT }]);
  });
});
