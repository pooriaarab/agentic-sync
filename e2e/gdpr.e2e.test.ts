import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as Y from "yjs";
import { SyncClient } from "../src/client/index.js";
import { fromBase64 } from "../src/core/base64.js";
import {
  deleteDocument,
  deleteDocumentAsHost,
  exportDocument,
  exportDocumentAsHost,
  revokePrincipal,
  setPrincipalRole,
  type AdminTarget,
  type Target,
} from "../src/sdk.js";
import { Peer } from "./peer.js";
import { startWorker, until, type Server } from "./server.js";

const HUMAN = { id: "person-1", kind: "human", machine: false };
const AGENT = { id: "agent-7", kind: "agent_of_human", machine: true };
const SECRET = randomBytes(32).toString("hex");

let server: Server;
const extra: Server[] = [];

beforeAll(async () => {
  server = await startWorker({ SYNC_ADMIN_SECRET: SECRET });
}, 120_000);

afterAll(async () => {
  await Promise.all([server, ...extra].map((s) => s?.stop()));
});

const target = (token: string, s: Server = server): Target => ({ server: s.http, token });
const host = (s: Server = server): AdminTarget => ({ server: s.http, secret: SECRET });
const join = (doc: string, token: string, s: Server = server) =>
  SyncClient.connect({ url: `${s.ws}/api/v1/docs/${doc}/ws?token=${token}`, timeoutMs: 3000 });
const text = (client: SyncClient) => client.doc.getText("body").toString();
const append = (client: SyncClient, piece: string) =>
  client.edit((doc) => doc.getText("body").insert(doc.getText("body").length, piece));
const status = async (path: string, token: string, init: RequestInit = {}, s: Server = server) =>
  (await fetch(`${s.http}${path}?token=${token}`, init)).status;
const meta = async (doc: string, s: Server = server) =>
  (await (await fetch(`${s.http}/api/v1/docs/${doc}?token=editor`)).json()) as {
    updates: number;
    compactions: number;
    contributors: unknown[];
  };

// A person and an agent write in turn, so the history holds both and compaction runs.
async function fill(doc: string, s: Server = server) {
  const [human, agent] = [await join(doc, "editor", s), await join(doc, "agent", s)];
  for (let i = 0; i < 8; i++) {
    const [writer, reader] = i % 2 === 0 ? [human, agent] : [agent, human];
    await append(writer, String(i));
    await until(() => text(reader) === text(writer), "the other client to see the edit");
    if (i === 3) await human.snapshot("halfway");
  }
  return { human, agent };
}

describe("export and delete, under wrangler dev", () => {
  test("an export holds the full history, with machine-made work marked", async () => {
    await fill("history");
    const lines = await exportDocument(target("editor2"), "history");
    expect(lines[0]).toMatchObject({ type: "meta", format: "agentic-realtime-export", version: 1 });
    expect(lines[0].compactions).toBeGreaterThanOrEqual(1);

    const state = new Y.Doc();
    Y.applyUpdate(state, fromBase64(lines.find((l) => l.type === "state")!.base64));
    expect(state.getText("body").toString()).toBe("01234567");
    expect(lines.find((l) => l.type === "roots")).toMatchObject({ roots: { body: "01234567" } });
    expect(lines.find((l) => l.type === "attribution")).toMatchObject({ authors: [HUMAN, AGENT], dropped: 0 });
    expect(lines.find((l) => l.type === "authors")).toMatchObject({ authors: [HUMAN, AGENT] });
    expect(lines.filter((l) => l.type === "update").length).toBeGreaterThan(0);
    for (const update of lines.filter((l) => l.type === "update")) {
      expect([HUMAN, AGENT]).toContainEqual(update.author);
    }

    const [snapshot] = lines.filter((l) => l.type === "snapshot");

    expect(snapshot).toMatchObject({ name: "halfway", author: HUMAN });
    const early = new Y.Doc();
    Y.applyUpdate(early, fromBase64(snapshot.base64));
    expect(early.getText("body").toString()).toBe("0123");
    expect(snapshot.attribution.authors).toEqual([HUMAN, AGENT]);

    const viaHost = await exportDocumentAsHost(host(), "history");
    expect(viaHost.map((l) => l.type)).toEqual(lines.map((l) => l.type));
  });

  test("only an owner or the host may export or delete, and a delete needs its confirmation", async () => {
    await fill("guarded");
    for (const token of ["editor", "agent", "viewer"]) {
      expect(await status("/api/v1/docs/guarded/export", token)).toBe(403);
      await expect(deleteDocument(target(token), "guarded")).rejects.toThrow("OWNER_ONLY");
    }
    expect(await status("/api/v1/docs/guarded/export", "nobody")).toBe(401);
    const wrong = { server: server.http, secret: "w".repeat(40) };
    await expect(deleteDocumentAsHost(wrong, "guarded")).rejects.toThrow("UNAUTHORIZED");
    await expect(exportDocumentAsHost(wrong, "guarded")).rejects.toThrow("UNAUTHORIZED");
    const bare = await fetch(`${server.http}/api/v1/docs/guarded?token=editor2`, { method: "DELETE" });
    expect(bare.status).toBe(400);
    const mismatch = await fetch(`${server.http}/api/v1/docs/guarded?token=editor2`, {
      method: "DELETE",
      body: JSON.stringify({ confirm: "other" }),
    });
    expect(mismatch.status).toBe(400);
    expect((await meta("guarded")).updates).toBeGreaterThan(0);
    expect(text(await join("guarded", "editor2"))).toBe("01234567");
  });

  test("a delete removes every stored trace and the id starts empty", async () => {
    const first = await startWorker({ SYNC_ADMIN_SECRET: SECRET });
    extra.push(first);
    await fill("erase", first);
    await revokePrincipal(host(first), "erase", "agent-9");
    const watcher = new Peer(`${first.ws}/api/v1/docs/erase/ws?token=viewer`);
    await watcher.synced;
    let code: number | undefined;
    void watcher.closed.then((value) => (code = value));

    const result = await deleteDocument(target("editor2", first), "erase");
    expect(result.sockets).toBeGreaterThanOrEqual(3);
    await until(() => code !== undefined, "the socket to close");
    expect(code).toBe(4004);

    const after = await meta("erase", first);
    expect(after).toMatchObject({ updates: 0, compactions: 0, contributors: [] });
    const names = (await (await fetch(`${first.http}/api/v1/docs/erase/snapshots?token=editor`)).json()) as unknown[];
    expect(names).toEqual([]);
    const log = (await (await fetch(`${first.http}/api/v1/docs/erase/attribution?token=editor`)).json()) as {
      ranges: unknown[];
    };
    expect(log.ranges).toEqual([]);
    expect(text(await join("erase", "editor2", first))).toBe("");
    // The ban went with the data.
    expect(await status("/api/v1/docs/erase", "agent", {}, first)).toBe(200);

    // The storage is gone, not only the memory.
    await first.stop();
    const second = await startWorker({ SYNC_ADMIN_SECRET: SECRET }, first.persist);
    extra.push(second);
    expect(text(await join("erase", "editor2", second))).toBe("");
    expect(await meta("erase", second)).toMatchObject({ updates: 0, compactions: 0, contributors: [] });

    // The id can be used again, with a fresh history.
    const again = await join("erase", "agent", second);
    await append(again, "new");
    const lines = await exportDocument(target("editor2", second), "erase");
    expect(lines.find((l) => l.type === "attribution")).toMatchObject({ authors: [AGENT] });
    expect(lines.filter((l) => l.type === "snapshot")).toEqual([]);
    expect(lines.find((l) => l.type === "caps")).toMatchObject({ caps: [] });
  }, 240_000);

  test("an export holds the caps and the bans", async () => {
    await fill("caps");
    await setPrincipalRole(host(), "caps", "person-1", "viewer");
    await revokePrincipal(host(), "caps", "agent-7");
    const lines = await exportDocument(target("editor2"), "caps");
    const caps = lines.find((l) => l.type === "caps");
    expect(caps).toMatchObject({ type: "caps" });
    expect([...caps!.caps].sort((a: { principalId: string }, b: { principalId: string }) => a.principalId.localeCompare(b.principalId))).toEqual([
      { principalId: "agent-7", cap: "revoked" },
      { principalId: "person-1", cap: "viewer" },
    ]);
  });

  test("the host can delete a document too", async () => {
    await fill("by-host");
    const result = await deleteDocumentAsHost(host(), "by-host");
    expect(result.sockets).toBeGreaterThanOrEqual(2);
    expect(await meta("by-host")).toMatchObject({ updates: 0, compactions: 0, contributors: [] });
  });
});
