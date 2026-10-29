import { expect, it } from "vitest";
import { runStorageContract } from "./storage.contract.js";
import { createMemoryStorage, exportStorage } from "./storage.js";

const stores = new Map<string, ReturnType<typeof createMemoryStorage>>();
runStorageContract("memory", {
  make: ({ shared, docId }) => {
    const id = `${shared}/${docId}`;
    if (!stores.has(id)) stores.set(id, createMemoryStorage());
    return stores.get(id)!;
  },
});

it("exports every entry as lines of JSON, with bytes as base64", async () => {
  const storage = createMemoryStorage();
  await storage.putAll({ "u:1": { update: new Uint8Array([1, 2]), at: 3 }, "cap:p": "revoked" });
  const text = await new Response(exportStorage(storage)).text();
  const lines = text.trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ type: "meta", format: "agentic-realtime-storage-export", version: 1 });
  expect(lines.slice(1)).toEqual([
    { type: "entry", key: "cap:p", value: "revoked" },
    { type: "entry", key: "u:1", value: { update: { $bytes: "AQI=" }, at: 3 } },
  ]);
});
