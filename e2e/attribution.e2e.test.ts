import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyncClient } from "../src/client/index.js";
import { blame, getAttribution, type Target } from "../src/sdk.js";
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
});
