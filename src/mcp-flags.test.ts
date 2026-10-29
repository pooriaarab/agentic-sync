import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { VERSION } from "./version.js";

// Ways `mcp --help` can fail: it exits 2 on an unknown flag, or it starts the server and waits on stdin.
// Each case runs the built bin with stdin left open and a bare environment (no principal).

const dist = (file: string) => join(process.cwd(), "dist", file);

function run(file: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [dist(file), ...args], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("error", (e) => resolve({ code: null, out, err: String(e) }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

describe("help and version never start the server", () => {
  const cases: [string, string[], "help" | "version"][] = [
    ["cli.js", ["--help"], "help"],
    ["cli.js", ["--version"], "version"],
    ["cli.js", ["mcp", "--help"], "help"],
    ["cli.js", ["mcp", "-h"], "help"],
    ["cli.js", ["mcp", "--version"], "version"],
    ["cli.js", ["mcp", "-V"], "version"],
    ["cli.js", ["mcp", "-v"], "version"],
    ["cli.js", ["-h"], "help"],
    ["cli.js", ["-V"], "version"],
    ["mcp-bin.js", ["--help"], "help"],
    ["mcp-bin.js", ["--version"], "version"],
    ["mcp-bin.js", ["-h"], "help"],
    ["mcp-bin.js", ["-V"], "version"],
    ["mcp-bin.js", ["-v"], "version"],
  ];
  for (const [file, args, kind] of cases) {
    test(`${file} ${args.join(" ")} exits 0 within 5 s`, async () => {
      const r = await run(file, args);
      expect([r.code, r.err]).toEqual([0, ""]);
      if (kind === "version") expect(r.out.trim()).toBe(VERSION);
      else expect(r.out).toContain("Usage");
    });
  }
});

describe("an unknown argument fails closed and never starts the server", () => {
  for (const [file, args] of [["cli.js", ["mcp", "--bogus"]], ["mcp-bin.js", ["--bogus"]]] as [string, string[]][]) {
    test(`${file} ${args.join(" ")} exits 2 within 5 s`, async () => {
      const r = await run(file, args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--bogus");
    });
  }
});
