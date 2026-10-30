#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as sdk from "./sdk.js";
import { ROLES, isPrincipalId, type Role } from "./core/types.js";
import { VERSION } from "./version.js";

export class UsageError extends Error {}

const FLAGS = ["server", "doc", "root", "text", "file", "mode", "at", "name", "wait", "snapshot", "principal", "role", "confirm"];
const SUBCOMMANDS = ["get", "apply", "snapshot", "restore", "presence", "blame", "export", "delete"];

export interface CliRequest {
  command: "help" | "version" | "mcp" | "doc" | "admin";
  sub?: string;
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): CliRequest {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h") return { command: "help", flags: {} };
  if (first === "--version" || first === "-V") return { command: "version", flags: {} };
  if (first === "mcp") {
    // `mcp --help` and `mcp --version` must answer and exit, never start the server.
    if (rest.some((a) => a === "--help" || a === "-h")) return { command: "help", flags: {} };
    if (rest.some((a) => a === "--version" || a === "-V" || a === "-v")) return { command: "version", flags: {} };
    if (rest.length > 0) throw new UsageError(`mcp takes no argument, got "${rest[0]}"`);
    return { command: "mcp", flags: {} };
  }
  if (first !== "doc" && first !== "admin") throw new UsageError(`unknown command "${first}"`);
  if (rest.includes("--help") || rest.includes("-h")) return { command: "help", flags: {} };
  const sub = rest.shift();
  const commands = first === "admin" ? ["export", "delete", "revoke", "role"] : SUBCOMMANDS;
  if (sub === undefined || !commands.includes(sub)) {
    throw new UsageError(`${first} needs one of: ${commands.join(", ")}`);
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
  if (sub === "delete" && flags.confirm !== flags.doc) throw new UsageError("delete needs --confirm matching --doc");
  if ((sub === "revoke" || sub === "role") && !isPrincipalId(flags.principal)) throw new UsageError("--principal needs a valid principal id");
  if (sub === "role" && flags.role !== "null" && !ROLES.includes(flags.role as Role)) throw new UsageError("--role needs owner|editor|commenter|viewer|null");
  return { command: first, sub, flags };
}

const HELP = `agentic-realtime ${VERSION}
Usage: agentic-realtime doc <get|apply|snapshot|restore|presence|blame|export|delete> --doc <id> [flags]
       agentic-realtime admin <export|delete|revoke|role> --doc <id> [flags]
       agentic-realtime mcp [-h | --help | -V | -v | --version]

Set AGENTIC_SYNC_URL and AGENTIC_SYNC_TOKEN. The token stays off the command line.

  delete --confirm <id>        Permanently erase the document. Owners only.
  admin export                 Export with AGENTIC_SYNC_ADMIN_SECRET.
  admin delete --confirm <id>  Erase with the host secret.
  admin revoke --principal <id>  Revoke a principal.
  admin role --principal <id> --role owner|editor|commenter|viewer|null
                               Cap a role; null lifts the cap or revoke.
  get                          Print every root as JSON.
  export                       Print stored history as a JSON array. Owners only.
  apply --root <r> --text <t> | --file <path|->   [--mode append|replace|insert] [--at <n>]
  snapshot [--name <n>]        Save a snapshot, or list them.
  restore --name <n>           Restore as a new edit.
  presence [--wait <ms>]       List the other peers.
  blame --root <r> [--snapshot <n>]   Print each run of text with the principal that wrote it.

Other flags: --server <url>, --name <label for peers; the snapshot name for snapshot and restore>. The server sets your kind from the token.`;

// `--name` is a snapshot name for these commands, so it is not a peer name.
function peerName(sub: string | undefined, name: string | undefined): string {
  return sub === "snapshot" || sub === "restore" || name === undefined ? "agentic-realtime cli" : name;
}

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
    const target: sdk.Target = { server, token: env.AGENTIC_SYNC_TOKEN, name: peerName(sub, flags.name) };
    const doc = flags.doc;
    let result: unknown;
    if (command === "admin") {
      const secret = env.AGENTIC_SYNC_ADMIN_SECRET;
      if (!secret) throw new UsageError("set AGENTIC_SYNC_ADMIN_SECRET for admin commands");
      const admin = sdk.createAdminClient({ server, secret });
      switch (sub) {
        case "export": result = await admin.exportDocument(doc); break;
        case "delete": result = await admin.deleteDocument(doc); break;
        case "revoke": result = await admin.revokePrincipal(doc, flags.principal); break;
        case "role": result = await admin.setPrincipalRole(doc, flags.principal, flags.role === "null" ? null : flags.role as Role); break;
      }
    } else switch (sub) {
      case "delete":
        result = await sdk.deleteDocument(target, doc);
        break;
      case "export":
        result = await sdk.exportDocument(target, doc);
        break;
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
