import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { connect, createServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Server {
  // The storage folder. Pass it to startWorker to start again on the same data.
  persist: string;
  http: string;
  ws: string;
  log(): string;
  stop(): Promise<void>;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

// Runs the test worker under wrangler dev with fresh storage. A worker
// that just stopped can still hold the runtime socket for a moment, so a
// start that finds it taken tries again.
export async function startWorker(
  vars: Record<string, string> = {},
  persist: string = mkdtempSync(join(tmpdir(), "agentic-realtime-e2e-")),
): Promise<Server> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchWorker(vars, persist);
    } catch (error) {
      if (attempt >= 4 || !String(error).includes("Address already in use")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function launchWorker(vars: Record<string, string>, persist: string): Promise<Server> {
  const port = await freePort();
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
    if (Date.now() > deadline) {
      // A run that stays alive would hold its sockets against the retry.
      child.kill("SIGTERM");
      throw new Error(`wrangler dev not ready:\n${log}`);
    }
    try {
      if ((await fetch(`${http}/health`)).ok) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return {
    persist,
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

// A TCP relay we can cut and bring back, to stand in for a lost network.
export class Proxy {
  private server?: NetServer;
  private readonly sockets = new Set<Socket>();

  constructor(readonly port: number, private readonly target: number) {}

  listen(): Promise<void> {
    this.server = createServer((client) => {
      const upstream = connect(this.target, "127.0.0.1");
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket)).on("error", () => socket.destroy());
      }
      client.pipe(upstream).pipe(client);
    });
    return new Promise((resolve) => this.server!.listen(this.port, "127.0.0.1", resolve));
  }

  cut(): Promise<void> {
    this.sockets.forEach((socket) => socket.destroy());
    return new Promise((resolve) => this.server!.close(() => resolve()));
  }
}
