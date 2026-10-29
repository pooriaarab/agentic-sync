import { afterAll, beforeAll, expect, test } from "vitest";
import { watchPageAway, type PageLike } from "../src/browser/index.js";
import { SyncClient } from "../src/client/index.js";
import { listPeers } from "../src/sdk.js";
import { Peer } from "./peer.js";
import { startWorker, until, type Server } from "./server.js";

let server: Server;
beforeAll(async () => {
  server = await startWorker();
}, 120_000);
afterAll(async () => {
  await server?.stop();
});

const wsFor = (doc: string, token: string) => `${server.ws}/api/v1/docs/${doc}/ws?token=${token}`;

// A page that tests can drive.
class FakePage implements PageLike {
  hidden = false;
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener));
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    this.listeners.get(type)?.forEach((l) => l());
  }
  count() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

test("peers see a client go idle, active, hidden, and visible", async () => {
  const mine = await SyncClient.connect({
    url: wsFor("away", "editor"),
    presence: { name: "Ana" },
    away: { idleAfterSeconds: 0.4 },
  });
  const watcher = await SyncClient.connect({ url: wsFor("away", "editor2"), presence: { name: "Bo" } });
  const page = new FakePage();
  const stop = watchPageAway(mine, page);
  const awayOf = () => watcher.peers.find((p) => p.name === "Ana")?.away;

  await until(() => awayOf() === "active", "active");
  await until(() => awayOf() === "idle", "idle");
  page.fire("keydown");
  await until(() => awayOf() === "active", "active after input");
  page.hidden = true;
  page.fire("visibilitychange");
  await until(() => awayOf() === "hidden", "hidden");
  // Input on a hidden page does not change it.
  page.fire("pointermove");
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(awayOf()).toBe("hidden");
  page.hidden = false;
  page.fire("visibilitychange");
  await until(() => awayOf() === "active", "visible again");

  stop();
  expect(page.count()).toBe(0);
  await Promise.all([mine.disconnect(), watcher.disconnect()]);
});

test("the SDK lists the away state, and a peer that reports none reads unknown", async () => {
  const tracked = await SyncClient.connect({
    url: wsFor("away-sdk", "editor"),
    presence: { name: "Tracked" },
    away: { idleAfterSeconds: 60 },
  });
  const plain = await SyncClient.connect({ url: wsFor("away-sdk", "editor2"), presence: { name: "Plain" } });
  const peers = await listPeers({ server: server.http, token: "viewer" }, "away-sdk", 500);
  expect(Object.fromEntries(peers.map((p) => [p.name, p.away]))).toEqual({ Tracked: "active", Plain: "unknown" });
  await Promise.all([tracked.disconnect(), plain.disconnect()]);
});

test("a raw peer cannot send a state outside the three", async () => {
  const raw = new Peer(wsFor("away-raw", "editor"));
  await raw.synced;
  const watcher = await SyncClient.connect({ url: wsFor("away-raw", "editor2"), presence: { name: "Watcher" } });
  raw.setPresence(95, 1, { name: "Mal", away: "<script>" });
  raw.setPresence(96, 1, { name: "Eve", away: { a: 1 } });
  raw.setPresence(97, 1, { name: "Zed", away: "idle" });
  await until(() => watcher.peers.length === 3, "three peers");
  expect(Object.fromEntries(watcher.peers.map((p) => [p.name, p.away]))).toEqual({
    Mal: "unknown",
    Eve: "unknown",
    Zed: "idle",
  });
  const bare = new Peer(wsFor("away-raw", "editor"));
  await bare.synced;
  await until(() => bare.awareness.some((e) => e.id === 95), "the relayed entry");
  expect(JSON.parse(bare.awareness.find((e) => e.id === 95)!.state)).not.toHaveProperty("away");
  await watcher.disconnect();
  raw.close();
  bare.close();
});

test("a bad idle time throws before the client connects", () => {
  expect(() =>
    SyncClient.open({ url: wsFor("away", "editor"), presence: { name: "Ana" }, away: { idleAfterSeconds: 0 } }),
  ).toThrow(RangeError);
});
