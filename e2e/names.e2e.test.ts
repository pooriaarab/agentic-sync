import { afterAll, beforeAll, expect, test } from "vitest";
import { SyncClient } from "../src/client/index.js";
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
const url = (token: string) => `${server.ws}/api/v1/docs/names/ws?token=${token}`;

test("the client refuses an unsafe name before it connects", () => {
  expect(() => SyncClient.open({ url: url("editor"), presence: { name: "Ana‮evil" } })).toThrow(/peer name/);
});

test("setPresence refuses an unsafe name and keeps the old one", async () => {
  const client = await SyncClient.connect({ url: url("editor"), presence: { name: "Ana" } });
  expect(() => client.setPresence({ name: "A​na" })).toThrow(/peer name/);
  expect(client.awareness.getLocalState()?.name).toBe("Ana");
  client.setPresence({ name: "Zoë" });
  expect(client.awareness.getLocalState()?.name).toBe("Zoë");
  await client.disconnect();
});

test("an unsafe name from a raw socket is dropped, the socket stays, and peers show Unknown", async () => {
  const raw = new Peer(wsFor("names-raw", "editor"));
  await raw.synced;
  const watcher = await SyncClient.connect({ url: wsFor("names-raw", "editor2"), presence: { name: "Watcher" } });
  for (const [id, name] of [[61, "Ana\u202Eevil"], [62, "A\u200Bna"], [63, "a".repeat(41)], [64, "e\u0301"]] as const) {
    raw.setPresence(id, 1, { name, color: "#000" });
  }
  await until(() => watcher.peers.length === 4, "four peers");
  expect(watcher.peers.map((p) => p.name)).toEqual(["Unknown", "Unknown", "Unknown", "Unknown"]);
  // A raw protocol peer gets the relayed state, which has no name at all.
  const bare = new Peer(wsFor("names-raw", "editor2"));
  await bare.synced;
  await until(() => [61, 62, 63, 64].every((id) => bare.awareness.some((e) => e.id === id)), "the relayed entries");
  for (const entry of bare.awareness.filter((e) => e.id >= 61 && e.id <= 64)) {
    expect(JSON.parse(entry.state)).toEqual({ color: "#000", kind: "human" });
  }
  bare.close();
  raw.setPresence(65, 1, { name: "Ana" });
  await until(() => watcher.peers.some((p) => p.name === "Ana"), "a safe name on the same socket");
  await watcher.disconnect();
  raw.close();
});

test("an unsafe host name is dropped from the relayed state", async () => {
  const host = new Peer(wsFor("names-host", "hostile"));
  await host.synced;
  host.setPresence(81, 1, { name: "Mallory", color: "#000" });
  const bare = new Peer(wsFor("names-host", "editor2"));
  await bare.synced;
  await until(() => bare.awareness.some((e) => e.id === 81), "the relayed entry");
  expect(JSON.parse(bare.awareness.find((e) => e.id === 81)!.state)).toEqual({ color: "#000", kind: "human" });
  host.close();
  bare.close();
});
