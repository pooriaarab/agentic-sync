import { afterAll, beforeAll, expect, test } from "vitest";
import { SyncClient } from "../src/client/index.js";
import { contrastRatio, peerColor, DARK_BACKGROUND, LIGHT_BACKGROUND } from "../src/core/colors.js";
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

test("a client without a color gets one that passes on a light and a dark page", async () => {
  const [a, b] = [
    await SyncClient.connect({ url: wsFor("colors", "editor"), presence: { name: "Ana" } }),
    await SyncClient.connect({ url: wsFor("colors", "editor2"), presence: { name: "Bo" } }),
  ];
  await until(() => a.peers.length === 1, "a peer");
  const [peer] = a.peers;
  expect(peer.color).toBe(peerColor("Bo"));
  expect(contrastRatio(peer.color, LIGHT_BACKGROUND)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(peer.color, DARK_BACKGROUND)).toBeGreaterThanOrEqual(3);
  await Promise.all([a.disconnect(), b.disconnect()]);
});

test("a raw peer cannot show a CSS string or a color that is hard to see", async () => {
  const watcher = await SyncClient.connect({ url: wsFor("colors-raw", "editor2"), presence: { name: "Watcher" } });
  const raw = new Peer(wsFor("colors-raw", "editor"));
  await raw.synced;
  raw.setPresence(91, 1, { name: "Mal", color: "red; background: url(https://x.example/a)" });
  raw.setPresence(92, 1, { name: "Yel", color: "#ffff00" });
  raw.setPresence(93, 1, { name: "Ok", color: "#DD3C6F" });
  await until(() => watcher.peers.length === 3, "three peers");
  const byName = Object.fromEntries(watcher.peers.map((p) => [p.name, p.color]));
  expect(byName).toEqual({ Mal: peerColor("Mal"), Yel: peerColor("Yel"), Ok: "#dd3c6f" });
  await watcher.disconnect();
  raw.close();
});
