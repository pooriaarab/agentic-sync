import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
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

export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface HalfOpenProxy {
  port: number;
  // Cuts the client side with no close frame. The server side stays
  // open and silent, as a dead network path looks to the server.
  blackhole(): void;
  // Close codes the server sent on the cut sockets.
  closeCodes(): number[];
  stop(): Promise<void>;
}

// A TCP relay in front of the worker, to drop a connection the way a
// laptop leaving a network does.
export async function halfOpenProxy(target: number): Promise<HalfOpenProxy> {
  const pairs: { client: Socket; upstream: Socket }[] = [];
  const cut: Buffer[] = [];
  const listener = createServer((client) => {
    const upstream = connect(target, "127.0.0.1");
    pairs.push({ client, upstream });
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const { port } = listener.address() as { port: number };
  return {
    port,
    blackhole() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        upstream.on("data", (chunk: Buffer) => cut.push(chunk));
        // Unpiping leaves the stream paused.
        upstream.resume();
        client.destroy();
      }
    },
    closeCodes() {
      // A server close frame: 0x88, a length, then the two code bytes.
      const bytes = Buffer.concat(cut);
      const codes: number[] = [];
      for (let i = 0; i + 3 < bytes.length; i++) {
        if (bytes[i] === 0x88 && bytes[i + 1] >= 2 && bytes[i + 1] < 126) {
          codes.push(bytes.readUInt16BE(i + 2));
        }
      }
      return codes;
    },
    async stop() {
      for (const { client, upstream } of pairs) {
        client.destroy();
        upstream.destroy();
      }
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}
