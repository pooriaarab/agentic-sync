import { createServer, type Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyncClient } from "../src/client/index.js";
import { revokePrincipal, setPrincipalRole } from "../src/sdk.js";
import type { Role } from "../src/core/types.js";
import { Peer } from "./peer.js";
import { freePort, startWorker, until, type Server } from "./server.js";

const SECRET = "e2e-admin-secret-".padEnd(40, "x");

let server: Server;
let feed: HttpServer;
let polled: Server;
// What the test host answers for each principal id. "error" is an outage.
const directory = new Map<string, Role | null | "error">();

beforeAll(async () => {
  const port = await freePort();
  feed = createServer((request, response) => {
    const answer = directory.get(decodeURIComponent((request.url ?? "").slice(1)));
    if (answer === undefined || answer === "error") response.writeHead(answer === undefined ? 404 : 500).end();
    else response.writeHead(200).end(JSON.stringify({ role: answer }));
  });
  await new Promise<void>((resolve) => feed.listen(port, "127.0.0.1", resolve));
  // One at a time: two wrangler dev starts at once fight over a socket.
  server = await startWorker({ SYNC_ADMIN_SECRET: SECRET });
  polled = await startWorker({
    SYNC_ADMIN_SECRET: SECRET,
    SYNC_REAUTH_INTERVAL_SECONDS: "1",
    ROLE_FEED_URL: `http://127.0.0.1:${port}`,
  });
}, 180_000);

afterAll(async () => {
  feed?.close();
  await Promise.all([server?.stop(), polled?.stop()]);
});

const admin = (target: Server) => ({ server: target.http, secret: SECRET });
const wsUrl = (target: Server, doc: string, token: string) =>
  `${target.ws}/api/v1/docs/${doc}/ws?token=${token}`;
const join = (target: Server, doc: string, token: string) =>
  SyncClient.connect({ url: wsUrl(target, doc, token), timeoutMs: 1500 });
const text = (client: SyncClient) => client.doc.getText("body").toString();
const status = async (target: Server, doc: string, token: string) =>
  (await fetch(`${target.http}/api/v1/docs/${doc}?token=${token}`)).status;

// Resolves with the close code of a socket the server ends.
function closeCodeOf(peer: Peer): () => number | undefined {
  let code: number | undefined;
  void peer.closed.then((value) => (code = value));
  return () => code;
}

describe("live revocation under wrangler dev", () => {
  test("admin routes need the host secret", async () => {
    const wrong = { server: server.http, secret: "w".repeat(40) };
    await expect(revokePrincipal(wrong, "gate", "person-1")).rejects.toThrow("UNAUTHORIZED");
    await expect(setPrincipalRole(wrong, "gate", "person-1", "viewer")).rejects.toThrow("UNAUTHORIZED");
    const bare = await fetch(`${server.http}/api/v1/admin/docs/gate/revoke`, { method: "POST", body: "{}" });
    expect(bare.status).toBe(401);
    expect(await status(server, "gate", "editor")).toBe(200);
  });

  test("a missing or short secret turns the admin routes off", async () => {
    const cases: Record<string, string>[] = [{}, { SYNC_ADMIN_SECRET: "short" }];
    for (const vars of cases) {
      const closed = await startWorker(vars);
      try {
        const secret = "x".repeat(40);
        await expect(
          revokePrincipal({ server: closed.http, secret }, "gate", "person-1"),
        ).rejects.toThrow("ADMIN_DISABLED");
      } finally {
        await closed.stop();
      }
    }
  }, 120_000);

  test("a downgraded editor is read-only at once, and the host can lift it", async () => {
    const [downgraded, other] = [await join(server, "role", "editor"), await join(server, "role", "editor2")];
    await downgraded.edit((doc) => doc.getText("body").insert(0, "a"));
    await until(() => text(other) === "a", "the first edit to arrive");
    await setPrincipalRole(admin(server), "role", "person-1", "viewer");
    await downgraded.edit((doc) => doc.getText("body").insert(0, "late"));
    expect(downgraded.denied).toEqual(["read-only role"]);
    const snapshot = await fetch(`${server.http}/api/v1/docs/role/snapshots?token=editor`, {
      method: "POST",
      body: JSON.stringify({ name: "capped" }),
    });
    expect(snapshot.status).toBe(403);
    await other.edit((doc) => doc.getText("body").insert(1, "b"));
    expect(text(other)).toBe("ab");
    expect(text(await join(server, "role", "editor2"))).toBe("ab");

    // The first client holds the refused edit, so the lifted editor starts fresh.
    await setPrincipalRole(admin(server), "role", "person-1", null);
    const lifted = await join(server, "role", "editor");
    await lifted.edit((doc) => doc.getText("body").insert(2, "c"));
    await until(() => text(other) === "abc", "the lifted editor's edit to arrive");
  });

  test("a revoked principal is disconnected, and its next update is rejected", async () => {
    const peer = new Peer(wsUrl(server, "revoked", "editor"));
    await peer.synced;
    const code = closeCodeOf(peer);
    const client = await join(server, "revoked", "editor");
    const watcher = await join(server, "revoked", "editor2");
    const bystander = new Peer(wsUrl(server, "revoked", "viewer"));
    await bystander.synced;

    expect(await revokePrincipal(admin(server), "revoked", "person-1")).toEqual({ closed: 2 });
    await until(() => code() !== undefined, "the revoked socket to close");
    expect(code()).toBe(4003);
    await expect(client.edit((doc) => doc.getText("body").insert(0, "evil"))).rejects.toThrow();
    await watcher.edit((doc) => doc.getText("body").insert(0, "ok"));
    expect(text(watcher)).toBe("ok");
    expect(text(await join(server, "revoked", "editor2"))).toBe("ok");

    expect(await status(server, "revoked", "editor")).toBe(403);
    await expect(join(server, "revoked", "editor")).rejects.toThrow();
    expect(await status(server, "revoked", "viewer")).toBe(200);
    expect(code()).toBe(4003);

    await setPrincipalRole(admin(server), "revoked", "person-1", null);
    expect(text(await join(server, "revoked", "editor"))).toBe("ok");
  });

  test("the timer drops a role that the host lowered or took away", async () => {
    directory.set("person-1", "editor");
    const client = await join(polled, "timer", "editor");
    const peer = new Peer(wsUrl(polled, "timer", "editor"));
    await peer.synced;
    const code = closeCodeOf(peer);

    directory.set("person-1", "viewer");
    await until(async () => {
      await client.edit((doc) => doc.getText("body").insert(0, "x"));
      return client.denied.length > 0;
    }, "the host's downgrade to reach the socket");
    expect(client.denied[0]).toBe("read-only role");
    expect(code()).toBeUndefined();

    directory.set("person-1", null);
    await until(() => code() !== undefined, "the host's removal to close the socket");
    expect(code()).toBe(4003);
  });

  test("a host outage closes the socket instead of keeping it open", async () => {
    directory.set("person-2", "owner");
    const peer = new Peer(wsUrl(polled, "outage", "editor2"));
    await peer.synced;
    const code = closeCodeOf(peer);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(code()).toBeUndefined();
    directory.set("person-2", "error");
    await until(() => code() !== undefined, "the outage to close the socket");
    expect(code()).toBe(4003);
  });
});
