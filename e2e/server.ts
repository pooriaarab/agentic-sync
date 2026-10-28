import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Server {
  http: string;
  ws: string;
  log(): string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// Runs the test worker under wrangler dev with fresh storage.
export async function startWorker(vars: Record<string, string> = {}): Promise<Server> {
  const port = await freePort();
  const persist = mkdtempSync(join(tmpdir(), "agentic-sync-e2e-"));
  const child: ChildProcess = spawn(
    "npx",
    ["wrangler", "dev", "--config", "e2e/worker/wrangler.jsonc", "--ip", "127.0.0.1",
      "--port", String(port), "--persist-to", persist,
      ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`])],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  let log = "";
  child.stdout?.on("data", (chunk) => (log += chunk));
  child.stderr?.on("data", (chunk) => (log += chunk));
  const http = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    if (Date.now() > deadline) throw new Error(`wrangler dev not ready:\n${log}`);
    try {
      if ((await fetch(`${http}/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return {
    http,
    ws: `ws://127.0.0.1:${port}`,
    log: () => log,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}
