import { afterAll, beforeAll, expect, test } from "vitest";
import { SyncClient } from "../src/client/index.js";
import { startWorker, type Server } from "./server.js";

let server: Server;
beforeAll(async () => {
  server = await startWorker();
}, 120_000);
afterAll(async () => {
  await server?.stop();
});

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
