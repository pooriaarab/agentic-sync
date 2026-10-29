import { afterAll, beforeAll, expect, test } from "vitest";
import { exportDocument } from "../src/sdk.js";
import { SyncClient } from "../src/client/index.js";
import { startWorker, type Server } from "./server.js";

const secret = "client-test-secret-with-at-least-32-bytes";
let server: Server;
const clients: SyncClient[] = [];
beforeAll(async () => { server = await startWorker({ SYNC_ADMIN_SECRET: secret }); }, 120_000);
afterAll(async () => {
  await Promise.all(clients.map((c) => c.disconnect()));
  await server?.stop();
});
async function connect(doc: string, token: string, header = false) {
  const c = await SyncClient.connect({
    url: `${server.ws}/api/v1/docs/${encodeURIComponent(doc)}/ws${header ? "" : `?token=${token}`}`,
    headers: header ? { Authorization: `Bearer ${token}` } : undefined,
  });
  clients.push(c);
  return c;
}

test("client export and delete enforce owner access and keep case and authors", async () => {
  const owner = await connect("ClientCase", "editor2", true);
  const editor = await connect("ClientCase", "agent");
  await editor.edit((doc) => doc.getText("body").insert(0, "history"));
  await editor.snapshot("SnapshotCase");
  for (const c of [editor, await connect("ClientCase", "viewer")]) {
    await expect(c.exportDocument()).rejects.toThrow("OWNER_ONLY");
    await expect(c.deleteDocument()).rejects.toThrow("OWNER_ONLY");
  }
  const records = await owner.exportDocument();
  expect(records[0]).toMatchObject({ type: "meta" });
  expect(records.find((r) => r.type === "update")?.author).toMatchObject({ kind: "agent_of_human" });
  expect(records.find((r) => r.type === "snapshot")).toMatchObject({ name: "SnapshotCase", author: { kind: "agent_of_human" } });
  const viaQuery = await (await connect("ClientCase", "editor2")).exportDocument();
  expect(viaQuery.slice(1)).toEqual(records.slice(1));
  const withToken = await exportDocument({ server: server.http, token: "editor2", headers: { Authorization: "Bearer viewer" } }, "ClientCase");
  expect(withToken.slice(1)).toEqual(records.slice(1));
  expect(await owner.deleteDocument()).toMatchObject({ deleted: true, sockets: 4 });
  const fresh = await connect("ClientCase", "editor2");
  expect(fresh.doc.getText("body").toString()).toBe("");
  expect((await fresh.exportDocument()).some((r) => r.type === "snapshot" || r.type === "update")).toBe(false);
});

test("client host methods reject bad secrets and cap, revoke, and lift roles", async () => {
  const owner = await connect("ClientRoles", "editor2");
  const editor = await connect("ClientRoles", "editor");
  await expect(owner.revokePrincipal("wrong", "person-1")).rejects.toThrow("UNAUTHORIZED");
  await expect(owner.setPrincipalRole("wrong", "person-1", "viewer")).rejects.toThrow("UNAUTHORIZED");
  await owner.setPrincipalRole(secret, "person-1", "viewer");
  await editor.edit((doc) => doc.getText("body").insert(0, "refused"));
  expect(editor.denied).toContain("read-only role");
  await owner.setPrincipalRole(secret, "person-1", null);
  const allowed = await connect("ClientRoles", "editor");
  await allowed.edit((doc) => doc.getText("body").insert(0, "allowed"));
  expect(allowed.denied).toEqual([]);
  expect(await owner.revokePrincipal(secret, "person-1")).toEqual({ closed: 2 });
  await expect(connect("ClientRoles", "editor")).rejects.toThrow();
  await owner.setPrincipalRole(secret, "person-1", null);
  expect((await connect("ClientRoles", "editor")).doc.getText("body").toString()).toBe("allowed");
});
