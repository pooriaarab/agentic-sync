import { expect, it } from "vitest";
import { runStorageContract } from "../core/storage.contract.js";
import { exportStorage } from "../core/storage.js";
import { createFirestoreStorage, FirestoreError, MAX_VALUE_BYTES } from "./index.js";
import { createFakeFirestore } from "./fake.js";

// With FIRESTORE_EMULATOR_HOST set, the suite runs against the Firestore emulator.
// A project id names one dataset there, so `shared` maps to a project. Without it,
// a fake of the REST surface runs.
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const fakes = new Map<string, ReturnType<typeof createFakeFirestore>>();
const projectFor = (shared: string) => `t${shared.replace(/-/g, "").slice(0, 20)}`;

runStorageContract(emulator ? "firestore emulator" : "firestore fake", {
  make({ shared, docId }) {
    const projectId = projectFor(shared);
    if (emulator) return createFirestoreStorage({ projectId, docId, fetch, baseUrl: `http://${emulator}`, token: "owner" });
    if (!fakes.has(shared)) fakes.set(shared, createFakeFirestore());
    return createFirestoreStorage({ projectId, docId, fetch: fakes.get(shared)!.fetch });
  },
});

it("sends the token from the provider on every call, and none when it has none", async () => {
  const fake = createFakeFirestore();
  let calls = 0;
  const storage = createFirestoreStorage({ projectId: "p", docId: "d", fetch: fake.fetch, token: () => `t${++calls}` });
  await storage.put("a", 1);
  await storage.get("a");
  expect(fake.requests.map((r) => r.authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  const open = createFakeFirestore();
  await createFirestoreStorage({ projectId: "p", docId: "d", fetch: open.fetch }).get("a");
  expect(open.requests[0]!.authorization).toBeNull();
});

it("exports a stored document", async () => {
  const fake = createFakeFirestore();
  const storage = createFirestoreStorage({ projectId: "p", docId: "d", fetch: fake.fetch });
  await storage.putAll({ base: { state: new Uint8Array([1]) }, "cap:x": "revoked" });
  const text = await new Response(exportStorage(storage)).text();
  expect(text).toContain('"key":"base"');
  expect(text).toContain('"key":"cap:x"');
});

it("refuses a value over the Firestore limit before any request", async () => {
  const fake = createFakeFirestore();
  const storage = createFirestoreStorage({ projectId: "p", docId: "d", fetch: fake.fetch });
  await expect(storage.put("big", new Uint8Array(MAX_VALUE_BYTES))).rejects.toThrow(/1 MB/);
  expect(fake.requests).toHaveLength(0);
});

it("never puts a token or a value in an error", async () => {
  const denied = (async () =>
    new Response(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "secret-text" } }), { status: 403 })) as typeof fetch;
  const storage = createFirestoreStorage({ projectId: "p", docId: "d", fetch: denied, token: "secret-token" });
  const error = await storage.put("a", "secret-text").catch((e: Error) => e);
  expect(error).toBeInstanceOf(FirestoreError);
  expect((error as Error).message).not.toMatch(/secret/);
});

it("makes no request except to the base url", async () => {
  const fake = createFakeFirestore();
  const storage = createFirestoreStorage({ projectId: "p", docId: "d", fetch: fake.fetch, baseUrl: "http://localhost:8080/" });
  await storage.put("a", 1);
  expect(fake.requests.every((r) => r.url.startsWith("http://localhost:8080/v1/projects/p/"))).toBe(true);
});
