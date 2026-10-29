import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { revokePrincipal } from "../src/sdk.js";
import { startWorker, until, type Server } from "./server.js";

// The steps of examples/host/README.md, run against the real example Worker.
const EXAMPLE = "examples/host/wrangler.jsonc";
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
  const devVars = "examples/host/.dev.vars";
  writeFileSync(devVars, `HOST_TOKENS='${TOKENS}'\nSYNC_ADMIN_SECRET='${SECRET}'\n`);
  try {
    server = await startWorker({}, undefined, EXAMPLE);
  } finally {
    rmSync(devVars, { force: true });
  }
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

  test("without a usable HOST_TOKENS the Worker serves no document", async () => {
    const cases: Record<string, string>[] = [{}, { HOST_TOKENS: JSON.stringify({ short: { principal: { id: "a", kind: "human" }, role: "owner" } }) }];
    for (const vars of cases) {
      const bare = await startWorker(vars, undefined, EXAMPLE);
      try {
        const response = await fetch(`${bare.http}/api/v1/docs/notes`, { headers: { authorization: `Bearer ${AGENT}` } });
        expect(response.status).toBe(500);
        // Wrangler prints the error a moment after the response.
        await until(() => /HOST_TOKENS/.test(bare.log()), "the Worker to log why it refuses");
      } finally {
        await bare.stop();
      }
    }
  }, 120_000);
});
