import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Peer } from "./peer.js";
import { halfOpenProxy, startWorker, until, type Server } from "./server.js";

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
    updates: number;
  }>;
const text = (peer: Peer) => peer.doc.getText("body").toString();
const MAX_STATE_CHARS = 8192;
const MAX_IDS_PER_SOCKET = 8;
const MAX_IDS_PER_PRINCIPAL = 16;
const MAX_IDS_PER_DOC = 256;
const lastState = (peer: Peer, id: number): Record<string, unknown> | null => {
  const entry = peer.awareness.filter((e) => e.id === id).at(-1);
  return entry === undefined || entry.state === "null" ? null : JSON.parse(entry.state);
};

async function join(doc: string, token: string): Promise<Peer> {
  const peer = new Peer(wsUrl(doc, token));
  await peer.synced;
  return peer;
}

// A bare protocol peer sends frames a well behaved client never sends.
describe("the server against a hostile client", () => {
  test("the server stamps the kind and name from the grant over what the client sent", async () => {
    const [agent, named, watcher] = [
      await join("stamp", "agent"),
      await join("stamp", "named"),
      await join("stamp", "editor2"),
    ];
    agent.setPresence(41, 1, { name: "Ana", kind: "human", color: "#0a0" });
    named.setPresence(42, 1, { name: "Mallory", kind: "agent" });
    await until(
      () => lastState(watcher, 41) !== null && lastState(watcher, 42) !== null,
      "both presence entries",
    );
    expect(lastState(watcher, 41)).toEqual({ name: "Ana", kind: "agent_of_human", color: "#0a0" });
    expect(lastState(watcher, 42)).toEqual({ name: "Ana", kind: "human" });
    const late = await join("stamp", "viewer");
    await until(() => lastState(late, 41) !== null, "presence for a late joiner");
    expect(lastState(late, 41)?.kind).toBe("agent_of_human");
  });

  test("a presence frame forwards only the entries the relay accepted", async () => {
    const [a, b] = [await join("accepted", "editor"), await join("accepted", "editor2")];
    a.setPresence(51, 5, { name: "a" });
    await until(() => lastState(b, 51) !== null, "the first entry");
    const seen = b.awareness.length;
    // Clock 3 is older than clock 5, so the relay drops it.
    a.sendPresence([
      { id: 51, clock: 3, state: JSON.stringify({ name: "old" }) },
      { id: 52, clock: 1, state: JSON.stringify({ name: "second" }) },
    ]);
    await until(() => lastState(b, 52) !== null, "the second entry");
    const fresh = b.awareness.slice(seen);
    expect(fresh.map((e) => `${e.id}@${e.clock}`)).toEqual(["52@1"]);
    expect(lastState(b, 51)).toMatchObject({ name: "a" });
  });

  test("a socket cannot update or remove a client id that another socket owns", async () => {
    const [owner, watcher, attacker] = [
      await join("bound", "editor"),
      await join("bound", "editor2"),
      await join("bound", "viewer"),
    ];
    owner.setPresence(61, 1, { name: "Ana" });
    await until(() => lastState(watcher, 61) !== null, "the owner's presence");
    attacker.sendPresence([{ id: 61, clock: 99, state: JSON.stringify({ name: "evil" }) }]);
    expect(await attacker.closed).toBe(1008);
    const second = await join("bound", "viewer");
    second.sendPresence([{ id: 61, clock: 100, state: "null" }]);
    expect(await second.closed).toBe(1008);
    owner.setPresence(61, 2, { name: "Ana again" });
    await until(() => lastState(watcher, 61)?.name === "Ana again", "the owner's next update");
    expect(watcher.awareness.some((e) => e.clock >= 99)).toBe(false);
    // The dropped socket held no claim on the id, so its close removes nothing.
    expect(lastState(watcher, 61)).not.toBeNull();
    const late = await join("bound", "viewer");
    await until(() => lastState(late, 61) !== null, "the owner's presence for a late joiner");
  });

  test("a socket that announces too many client ids is dropped", async () => {
    const [watcher, noisy] = [await join("cap-socket", "editor2"), await join("cap-socket", "editor")];
    const ids = Array.from({ length: MAX_IDS_PER_SOCKET + 1 }, (_, i) => 1000 + i);
    noisy.sendPresence(ids.map((id) => ({ id, clock: 1, state: JSON.stringify({ n: id }) })));
    expect(await noisy.closed).toBe(1008);
    expect(watcher.awareness).toEqual([]);
  });

  test("one principal cannot fill the relay with many sockets", async () => {
    const watcher = await join("cap-principal", "editor2");
    const idsFor = (base: number) =>
      Array.from({ length: MAX_IDS_PER_SOCKET }, (_, i) => ({
        id: base + i,
        clock: 1,
        state: JSON.stringify({ n: base + i }),
      }));
    const first = await join("cap-principal", "editor");
    first.sendPresence(idsFor(5000));
    const second = await join("cap-principal", "editor");
    second.sendPresence(idsFor(5100));
    await until(() => lastState(watcher, 5100 + MAX_IDS_PER_SOCKET - 1) !== null, "two sockets");
    expect(MAX_IDS_PER_PRINCIPAL).toBe(2 * MAX_IDS_PER_SOCKET);
    const third = await join("cap-principal", "editor");
    third.sendPresence(idsFor(5200));
    expect(await third.closed).toBe(1008);
    expect(lastState(watcher, 5200)).toBeNull();
    // Another principal still gets its own share.
    const other = await join("cap-principal", "editor2");
    other.setPresence(5300, 1, { name: "other" });
    await until(() => lastState(watcher, 5300) !== null, "another principal's presence");
  });

  test("a full relay refuses the new entry and keeps every socket open", async () => {
    const watcher = await join("cap-doc", "editor2");
    const fillers: Peer[] = [];
    let next = 2000;
    for (let user = 0; user < MAX_IDS_PER_DOC / MAX_IDS_PER_PRINCIPAL; user++) {
      for (let socket = 0; socket < MAX_IDS_PER_PRINCIPAL / MAX_IDS_PER_SOCKET; socket++) {
        const peer = await join("cap-doc", `user-${user}`);
        peer.sendPresence(
          Array.from({ length: MAX_IDS_PER_SOCKET }, () => {
            const id = next++;
            return { id, clock: 1, state: JSON.stringify({ n: id }) };
          }),
        );
        fillers.push(peer);
      }
    }
    await until(() => lastState(watcher, next - 1) !== null, "the relay to fill");
    // A stock client sends its own state as soon as it connects.
    const innocent = await join("cap-doc", "editor");
    innocent.setPresence(9000, 1, { name: "late" });
    await until(() => innocent.denied.includes("presence is full"), "the presence-full signal");
    expect(lastState(watcher, 9000)).toBeNull();
    // Document sync still works for the refused socket, both ways.
    innocent.doc.getText("body").insert(0, "still editing");
    await until(() => text(watcher) === "still editing", "an edit from the refused socket");
    watcher.doc.getText("body").insert(0, "reply:");
    await until(() => text(innocent).startsWith("reply:"), "an edit for the refused socket");
    // A holder keeps updating its own entry on a full relay.
    fillers[0].setPresence(2000, 2, { n: "again" });
    await until(() => lastState(watcher, 2000)?.n === "again", "an update on a full relay");
    // A holder that leaves frees room, and the next entry fits.
    fillers[1].close();
    await until(() => lastState(watcher, 2000 + MAX_IDS_PER_SOCKET) === null, "a holder to leave");
    innocent.setPresence(9000, 2, { name: "late" });
    await until(() => lastState(watcher, 9000) !== null, "the entry to fit after room frees");
    const late = await join("cap-doc", "editor2");
    await until(() => late.awareness.length > 0, "the stored presence");
    expect(new Set(late.awareness.map((e) => e.id)).size).toBeLessThanOrEqual(MAX_IDS_PER_DOC);
  });

  test("the same principal takes over a client id from a half-open socket", async () => {
    const proxy = await halfOpenProxy(Number(new URL(server.http).port));
    const watcher = await join("takeover", "editor2");
    const old = new Peer(`ws://127.0.0.1:${proxy.port}/api/v1/docs/takeover/ws?token=editor`);
    await old.synced;
    old.doc.getText("body").insert(0, "before");
    old.setPresence(301, 1, { name: "old" });
    old.setPresence(302, 1, { name: "old second id" });
    await until(
      () => text(watcher) === "before" && lastState(watcher, 301) !== null,
      "the first socket's work",
    );
    // The network drops. The server sees no close frame and keeps the socket.
    proxy.blackhole();
    await old.closed;
    const fresh = await join("takeover", "editor");
    expect(text(fresh)).toBe("before");
    fresh.setPresence(301, 2, { name: "fresh" });
    await until(() => lastState(watcher, 301)?.name === "fresh", "the new socket's presence");
    fresh.doc.getText("body").insert(6, " after");
    await until(() => text(watcher) === "before after", "an edit from the new socket");
    // The server closed the old socket with its own code.
    await until(() => proxy.closeCodes().includes(4001), "the server to close the old socket");
    // The old socket's other id goes away. The taken-over id never blinks.
    await until(
      () => watcher.awareness.some((e) => e.id === 302 && e.state === "null"),
      "the old socket's other id to clear",
    );
    expect(watcher.awareness.some((e) => e.id === 301 && e.state === "null")).toBe(false);
    const late = await join("takeover", "viewer");
    await until(() => lastState(late, 301)?.name === "fresh", "one entry for a late joiner");
    // A different principal still cannot claim the id.
    const thief = await join("takeover", "viewer");
    thief.setPresence(301, 9, { name: "thief" });
    expect(await thief.closed).toBe(1008);
    await proxy.stop();
  });

  test("a bad presence entry drops the socket and relays nothing", async () => {
    const watcher = await join("bad-state", "editor2");
    const cases: { name: string; entry: { id: number; clock: number; state: string } }[] = [
      { name: "too large", entry: { id: 71, clock: 1, state: JSON.stringify({ x: "a".repeat(MAX_STATE_CHARS) }) } },
      { name: "not JSON", entry: { id: 72, clock: 1, state: "{nope" } },
      { name: "not an object", entry: { id: 73, clock: 1, state: JSON.stringify([1, 2]) } },
      { name: "bidi override in the name", entry: { id: 74, clock: 1, state: JSON.stringify({ name: "Ana\u202Eevil" }) } },
      { name: "zero-width name", entry: { id: 75, clock: 1, state: JSON.stringify({ name: "A\u200Bna" }) } },
      { name: "name too long", entry: { id: 76, clock: 1, state: JSON.stringify({ name: "a".repeat(41) }) } },
      { name: "name that is not a string", entry: { id: 77, clock: 1, state: JSON.stringify({ name: { x: 1 } }) } },
    ];
    for (const { entry } of cases) {
      const bad = await join("bad-state", "editor");
      bad.sendPresence([
        { id: entry.id + 100, clock: 1, state: JSON.stringify({ ok: true }) },
        entry,
      ]);
      expect(await bad.closed).toBe(1008);
    }
    expect(watcher.awareness.filter((e) => e.state !== "null")).toEqual([]);
  });

  test("a malformed frame closes the socket with 1007 or 1009", async () => {
    const frames: [string, Uint8Array, number][] = [
      ["a truncated awareness frame", Uint8Array.of(1, 1, 0xff), 1007],
      ["an awareness entry list that overruns", Uint8Array.of(1, 3, 0x05, 0x01, 0x02, 0x03, 0x04), 1007],
      ["an unknown message type", Uint8Array.of(9), 1007],
      ["an unknown sync message", Uint8Array.of(0, 9), 1007],
      ["a frame over 1 MiB", new Uint8Array(1024 * 1024 + 1), 1009],
    ];
    for (const [, bytes, code] of frames) {
      const peer = await join("malformed", "editor");
      peer.sendRaw(bytes);
      expect(await peer.closed).toBe(code);
    }
  });

  test("an update that would push the document past its size cap is refused", async () => {
    const [editor, watcher] = [await join("size-cap", "editor"), await join("size-cap", "editor2")];
    const big = "a".repeat(900 * 1024);
    editor.doc.getText("body").insert(0, big);
    await until(() => text(watcher).length === big.length, "the first large update");
    editor.doc.getText("body").insert(0, big);
    await until(() => editor.denied.length > 0, "the size refusal");
    expect(editor.denied[0]).toContain("size");
    const late = await join("size-cap", "editor2");
    expect(text(late).length).toBe(big.length);
    // Small edits still work after a refusal.
    watcher.doc.getText("body").insert(0, "ok");
    await until(async () => (await metaOf("size-cap")).updates >= 2, "a small update to store");
  });
});
