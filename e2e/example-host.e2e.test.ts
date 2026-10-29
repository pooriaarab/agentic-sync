import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyncClient } from "../src/client/index.js";
import { revokePrincipal } from "../src/sdk.js";
import { startWorker, until, type Server } from "./server.js";

// The steps of examples/host/README.md, run against the real example Worker.
// Each test Worker runs from a copy in a temp folder, so no test reads or writes the
// .dev.vars that a reader made in examples/host. The copy points its alias at this build.
function exampleCopy(devVars?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agentic-realtime-example-"));
  copyFileSync("examples/host/worker.ts", join(dir, "worker.ts"));
  const config = readFileSync("examples/host/wrangler.jsonc", "utf8").replace("../../dist/worker.js", resolve("dist/worker.js"));
  writeFileSync(join(dir, "wrangler.jsonc"), config);
  if (devVars !== undefined) writeFileSync(join(dir, ".dev.vars"), devVars);
  return join(dir, "wrangler.jsonc");
}
const SECRET = randomBytes(32).toString("hex");
const [OWNER, VIEWER, AGENT] = [1, 2, 3].map(() => randomBytes(32).toString("hex"));
const TOKENS = JSON.stringify({
  [OWNER]: { principal: { id: "ana", kind: "human" }, role: "owner", name: "Ana" },
  [VIEWER]: { principal: { id: "bo", kind: "human" }, role: "viewer" },
  [AGENT]: { principal: { id: "bot-1", kind: "agent_of_human" }, role: "editor", docs: ["notes"] },
});

let server: Server;

beforeAll(async () => {
  if (!existsSync("dist/cli.js")) throw new Error("run npm run build first");
  // The README says to put the secrets in .dev.vars, so this does the same.
  // The README says to put the secrets in .dev.vars, so this does the same.
  const devVars = `HOST_TOKENS='${TOKENS}'\nSYNC_ADMIN_SECRET='${SECRET}'\n`;
  server = await startWorker({}, undefined, exampleCopy(devVars));
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

function cli(args: string[], token: string): Promise<{ code: number; out: string; err: string }> {
  const env = { ...process.env, AGENTIC_SYNC_URL: server.http, AGENTIC_SYNC_TOKEN: token };
  return new Promise((resolve) =>
    execFile("node", ["dist/cli.js", ...args], { env }, (error, out, err) =>
      resolve({ code: error ? Number(error.code) : 0, out, err }),
    ),
  );
}

describe("the example host, as its README runs it", () => {
  test("a call with no token or an unknown token gets 401", async () => {
    expect((await fetch(`${server.http}/api/v1/docs/notes`)).status).toBe(401);
    const unknown = await fetch(`${server.http}/api/v1/docs/notes`, {
      headers: { authorization: `Bearer ${randomBytes(32).toString("hex")}` },
    });
    expect(unknown.status).toBe(401);
  });

  test("an agent writes, shows as machine-made, and stays inside its documents", async () => {
    expect((await cli(["doc", "apply", "--doc", "notes", "--root", "body", "--text", "Hello from an agent"], AGENT)).code).toBe(0);
    expect(JSON.parse((await cli(["doc", "get", "--doc", "notes"], AGENT)).out)).toEqual({ body: "Hello from an agent" });
    const spans = JSON.parse((await cli(["doc", "blame", "--doc", "notes", "--root", "body"], AGENT)).out);
    expect(spans).toEqual([
      { text: "Hello from an agent", author: { id: "bot-1", kind: "agent_of_human", machine: true } },
    ]);
    expect((await cli(["doc", "get", "--doc", "other"], AGENT)).code).toBe(1);
  });

  test("a viewer reads and cannot edit, and an owner edits", async () => {
    expect(JSON.parse((await cli(["doc", "get", "--doc", "notes"], VIEWER)).out)).toEqual({ body: "Hello from an agent" });
    const refused = await cli(["doc", "apply", "--doc", "notes", "--root", "body", "--text", "x"], VIEWER);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("read-only role");
    expect((await cli(["doc", "apply", "--doc", "other", "--root", "body", "--text", "mine"], OWNER)).code).toBe(0);
  });

  test("the host secret revokes an agent at once", async () => {
    await revokePrincipal({ server: server.http, secret: SECRET }, "notes", "bot-1");
    expect((await cli(["doc", "get", "--doc", "notes"], AGENT)).code).toBe(1);
    expect((await cli(["doc", "get", "--doc", "notes"], OWNER)).code).toBe(0);
  });

  test("the timer keeps the widest role of the tokens of one principal", async () => {
    const [view, own] = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
    const table = JSON.stringify({
      [view]: { principal: { id: "ana", kind: "human" }, role: "viewer" },
      [own]: { principal: { id: "ana", kind: "human" }, role: "owner" },
    });
    const timed = await startWorker({ HOST_TOKENS: table, SYNC_REAUTH_INTERVAL_SECONDS: "1" }, undefined, exampleCopy());
    try {
      const client = await SyncClient.connect({
        url: `${timed.ws}/api/v1/docs/timer/ws`,
        headers: { authorization: `bearer  ${own}` },
        timeoutMs: 3000,
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await client.edit((doc) => doc.getText("body").insert(0, "still owner"));
      expect(client.denied).toEqual([]);
    } finally {
      await timed.stop();
    }
  }, 120_000);

  test("a table that cannot load makes the Worker serve no document, and logs no token", async () => {
    const token = randomBytes(32).toString("hex");
    const grant = { principal: { id: "a", kind: "human" }, role: "owner" };
    const cases: { vars: Record<string, string>; why: RegExp }[] = [
      { vars: {}, why: /set HOST_TOKENS/ },
      { vars: { HOST_TOKENS: JSON.stringify({ short: grant }) }, why: /at least 32 bytes/ },
      { vars: { HOST_TOKENS: `{"${token}": owner}` }, why: /not valid JSON/ },
      { vars: { HOST_TOKENS: JSON.stringify({ [token]: { ...grant, docs: "notes" } }) }, why: /docs in HOST_TOKENS/ },
      { vars: { HOST_TOKENS: JSON.stringify({ [`${token} with a space`]: grant }) }, why: /must not contain whitespace/ },
    ];
    for (const { vars, why } of cases) {
      const bare = await startWorker(vars, undefined, exampleCopy());
      try {
        const response = await fetch(`${bare.http}/api/v1/docs/notes`, { headers: { authorization: `Bearer ${AGENT}` } });
        expect(response.status).toBe(500);
        // Wrangler prints the error a moment after the response.
        await until(() => why.test(bare.log()), "the Worker to log why it refuses");
        expect(bare.log()).not.toContain(token.slice(-7));
      } finally {
        await bare.stop();
      }
    }
  }, 240_000);
});
