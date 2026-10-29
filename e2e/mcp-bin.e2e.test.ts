import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "vitest";

// The built bin, run as a real process. Its stdin stays open, as it does in a terminal or under an MCP client.
const BIN = join(process.cwd(), "dist", "mcp-bin.js");
const { version } = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  if (!existsSync(BIN)) throw new Error("dist/mcp-bin.js is missing: run npm run build first");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 5000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

test.each(["--help", "-h"])("%s prints usage to stdout and exits 0 within 5 s", async (flag) => {
  const started = Date.now();
  const result = await run([flag]);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Usage: agentic-realtime-mcp [--help | --version]");
  expect(result.stderr).toBe("");
  expect(Date.now() - started).toBeLessThan(5000);
}, 10_000);

test.each(["--version", "-V"])("%s prints the package version and exits 0", async (flag) => {
  const result = await run([flag]);
  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`${version}\n`);
  expect(result.stderr).toBe("");
});

test("no arguments starts the MCP server on stdio", async () => {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN] }));
  try {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
}, 20_000);
