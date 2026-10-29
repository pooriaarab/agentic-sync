#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as sdk from "./sdk.js";
import { VERSION } from "./version.js";

export class UsageError extends Error {}

const FLAGS = ["server", "doc", "root", "text", "file", "mode", "at", "name", "wait", "snapshot"];
const SUBCOMMANDS = ["get", "apply", "snapshot", "restore", "presence", "blame"];

export interface CliRequest {
  command: "help" | "version" | "mcp" | "doc";
  sub?: string;
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): CliRequest {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") return { command: "help", flags: {} };
  if (first === "--version" || first === "-V") return { command: "version", flags: {} };
  if (first === "mcp") return { command: "mcp", flags: {} };
  if (first !== "doc") throw new UsageError(`unknown command "${first}"`);
  const sub = rest.shift();
  if (sub === undefined || !SUBCOMMANDS.includes(sub)) {
    throw new UsageError(`doc needs one of: ${SUBCOMMANDS.join(", ")}`);
  }
  const flags: Record<string, string> = {};
  while (rest.length > 0) {
    const flag = rest.shift()!.replace(/^--/, "");
    const value = rest.shift();
    if (!FLAGS.includes(flag)) throw new UsageError(`bad flag "--${flag}"`);
    // A value that is the name of another flag means the real value is missing.
    if (value === undefined || (value.startsWith("--") && FLAGS.includes(value.slice(2)))) {
      throw new UsageError(`--${flag} needs a value`);
    }
    flags[flag] = value;
  }
  if (flags.mode !== undefined && !sdk.EDIT_MODES.includes(flags.mode as sdk.EditMode)) {
    throw new UsageError(`--mode is one of ${sdk.EDIT_MODES.join(", ")}`);
  }
  for (const flag of ["at", "wait"]) {
    if (flags[flag] !== undefined && !/^\d+$/.test(flags[flag])) {
      throw new UsageError(`--${flag} needs a whole number, 0 or more`);
    }
  }
  if (flags.doc === undefined) throw new UsageError("doc commands need --doc <id>");
  const need = { apply: ["root"], restore: ["name"], blame: ["root"] }[sub as "apply" | "restore" | "blame"] ?? [];
  for (const flag of need) if (!flags[flag]) throw new UsageError(`doc ${sub} needs --${flag}`);
  if (sub === "apply" && flags.text === undefined && flags.file === undefined) {
    throw new UsageError("doc apply needs --text or --file");
  }
  return { command: "doc", sub, flags };
}

const HELP = `agentic-realtime ${VERSION}
Usage: agentic-realtime doc <get|apply|snapshot|restore|presence|blame> --doc <id> [flags]
       agentic-realtime mcp

Set AGENTIC_SYNC_URL and AGENTIC_SYNC_TOKEN. The token stays off the command line.

  get                          Print every root as JSON.
  apply --root <r> --text <t> | --file <path|->   [--mode append|replace|insert] [--at <n>]
  snapshot [--name <n>]        Save a snapshot, or list them.
  restore --name <n>           Restore as a new edit.
  presence [--wait <ms>]       List the other peers.
  blame --root <r> [--snapshot <n>]   Print each run of text with the principal that wrote it.

Other flags: --server <url>, --name <label for peers>. The server sets your kind from the token.`;

export async function runCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  try {
    const { command, sub, flags } = parseArgs(argv);
    if (command === "help") return console.log(HELP), 0;
    if (command === "version") return console.log(VERSION), 0;
    if (command === "mcp") {
      await (await import("./mcp.js")).startMcp(env);
      return 0;
    }
    const server = flags.server ?? env.AGENTIC_SYNC_URL;
    if (!server) throw new UsageError("set AGENTIC_SYNC_URL or pass --server");
    const target: sdk.Target = { server, token: env.AGENTIC_SYNC_TOKEN, name: flags.name ?? "agentic-realtime cli" };
    const doc = flags.doc;
    let result: unknown;
    switch (sub) {
      case "get":
        result = await sdk.getDoc(target, doc);
        break;
      case "apply":
        result = await sdk.applyText(target, doc, {
          root: flags.root,
          text: flags.text ?? readFileSync(flags.file === "-" ? 0 : flags.file, "utf8"),
          mode: (flags.mode ?? "append") as sdk.EditMode,
          at: flags.at === undefined ? undefined : Number(flags.at),
        });
        break;
      case "snapshot":
        result = flags.name
          ? await sdk.createSnapshot(target, doc, flags.name)
          : await sdk.listSnapshots(target, doc);
        break;
      case "restore":
        result = await sdk.restoreSnapshot(target, doc, flags.name);
        break;
      case "blame":
        result = await sdk.blame(target, doc, flags.root, flags.snapshot);
        break;
      default:
        result = await sdk.listPeers(target, doc, flags.wait === undefined ? undefined : Number(flags.wait));
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const usage = error instanceof UsageError;
    console.error(`${(error as Error).message}${usage ? '\nRun "agentic-realtime --help" for usage.' : ""}`);
    return usage ? 2 : 1;
  }
}

function isMainModule(): boolean {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then((code) => {
    // A zero exit lets the MCP server keep running. Others end by themselves.
    if (code !== 0) process.exit(code);
  });
}
