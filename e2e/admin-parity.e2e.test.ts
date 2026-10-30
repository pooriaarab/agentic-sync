import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { applyText, createAdminClient, createDocumentClient } from "../src/sdk.js";
import { startWorker, type Server } from "./server.js";

const secret = "test-admin-parity-".repeat(3);
let server: Server;
beforeAll(async () => { server = await startWorker({ SYNC_ADMIN_SECRET: secret }); }, 120_000);
afterAll(async () => { await server?.stop(); });

const environment = (token: string, hostSecret = secret) => ({
  ...process.env, AGENTIC_SYNC_URL: server.http, AGENTIC_SYNC_TOKEN: token,
  AGENTIC_SYNC_ADMIN_SECRET: hostSecret, AGENTIC_SYNC_ENABLE_ADMIN: "1",
}) as Record<string, string>;

async function surface(kind: string, token = "editor2", hostSecret = secret) {
  const client = new Client({ name: "parity", version: "1" });
  if (kind === "mcp") await client.connect(new StdioClientTransport({
    command: "node", args: ["dist/cli.js", "mcp"], env: environment(token, hostSecret),
  }));
  const owner = createDocumentClient({ server: server.http, token });
  const host = createAdminClient({ server: server.http, secret: hostSecret });
  return {
    close: async () => { if (kind === "mcp") await client.close(); },
    async call(admin: boolean, action: string, doc: string, extra: Record<string, any> = {}): Promise<any> {
      if (kind === "sdk") {
        const c = admin ? host : owner;
        if (action === "export") return c.exportDocument(doc);
        if (action === "delete") return c.deleteDocument(doc);
        if (action === "revoke") return host.revokePrincipal(doc, extra.principalId);
        return host.setPrincipalRole(doc, extra.principalId, extra.role);
      }
      if (kind === "cli") {
        const args = [admin ? "admin" : "doc", action, "--doc", doc];
        if (action === "delete") args.push("--confirm", extra.confirm ?? doc);
        if (extra.principalId !== undefined) args.push("--principal", extra.principalId);
        if ("role" in extra) args.push("--role", String(extra.role));
        return new Promise((resolve, reject) => execFile("node", ["dist/cli.js", ...args],
          { env: environment(token, hostSecret) }, (error, out, err) => error ? reject(new Error(err)) : resolve(JSON.parse(out))));
      }
      const reply = await client.callTool({ name: `${admin ? "admin" : "doc"}_${action}`, arguments: {
        doc, ...(action === "delete" ? { confirm: doc } : {}), ...extra,
      } }) as { isError?: boolean; content: { text: string }[] };
      if (reply.isError) throw new Error(reply.content[0].text);
      return JSON.parse(reply.content[0].text);
    },
  };
}

for (const kind of ["sdk", "cli", "mcp"]) test(`${kind}: owner and host operations enforce Worker permissions`, async () => {
  const doc = `Parity-${kind}`;
  const target = { server: server.http, token: "agent" };
  await applyText(target, doc, { root: "body", text: "history" });
  const owner = await surface(kind);
  const viewer = await surface(kind, "viewer", "wrong");
  const missing = await surface(kind, "nobody", "");
  try {
    expect((await owner.call(false, "export", doc))[0].type).toBe("meta");
    expect((await owner.call(true, "export", doc))[0].type).toBe("meta");
    for (const action of ["export", "delete"]) {
      await expect(viewer.call(false, action, doc)).rejects.toThrow("OWNER_ONLY");
      await expect(missing.call(false, action, doc)).rejects.toThrow();
      await expect(viewer.call(true, action, doc)).rejects.toThrow("UNAUTHORIZED");
      await expect(missing.call(true, action, doc)).rejects.toThrow();
    }
    for (const action of ["revoke", "role"]) {
      await expect(viewer.call(true, action, doc, { principalId: "agent-7", role: "viewer" })).rejects.toThrow("UNAUTHORIZED");
      await expect(owner.call(true, action, doc, { principalId: "", role: "viewer" })).rejects.toThrow();
    }
    await expect(owner.call(true, "role", doc, { principalId: "agent-7", role: "invalid" })).rejects.toThrow();
    expect(await owner.call(true, "role", doc, { principalId: "agent-7", role: "viewer" })).toEqual({ ok: true });
    await expect(applyText(target, doc, { root: "body", text: "denied" })).rejects.toThrow();
    expect(await owner.call(true, "revoke", doc, { principalId: "agent-7" })).toHaveProperty("closed");
    await expect(applyText(target, doc, { root: "body", text: "denied" })).rejects.toThrow();
    await owner.call(true, "role", doc, { principalId: "agent-7", role: null });
    await applyText(target, doc, { root: "body", text: " restored" });
    if (kind !== "sdk") await expect(owner.call(false, "delete", doc, { confirm: "other" })).rejects.toThrow();
    expect(await owner.call(false, "delete", doc)).toMatchObject({ deleted: true });
    await applyText(target, doc, { root: "body", text: "fresh" });
    expect(await owner.call(true, "delete", doc)).toMatchObject({ deleted: true });
    const records = await owner.call(false, "export", doc);
    expect(records.filter((r: any) => r.type === "update")).toEqual([]);
  } finally { await owner.close(); await viewer.close(); await missing.close(); }
}, 60_000);

test("CLI subcommand help and MCP host opt-in", async () => {
  for (const args of [["doc", "delete"], ...["export", "delete", "revoke", "role"].map((a) => ["admin", a])]) {
    const output = await new Promise<string>((resolve, reject) => execFile("node", ["dist/cli.js", ...args, "--help"],
      (error, out) => error ? reject(error) : resolve(out)));
    expect(output).toContain("--confirm");
  }
  const client = new Client({ name: "parity", version: "1" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp"],
    env: { ...environment("editor2"), AGENTIC_SYNC_ENABLE_ADMIN: "0" } }));
  try { expect((await client.listTools()).tools.some((t) => t.name.startsWith("admin_"))).toBe(false); }
  finally { await client.close(); }
});
