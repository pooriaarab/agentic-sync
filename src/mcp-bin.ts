#!/usr/bin/env node
import { VERSION } from "./version.js";

const HELP = `agentic-realtime-mcp ${VERSION}
Usage: agentic-realtime-mcp [-h | --help | -V | -v | --version]

Runs the MCP server on stdio. An MCP client starts it.
`;

// Same rule as `agentic-realtime mcp`: help wins over version, and any other argument fails closed.
const args = process.argv.slice(2);
const has = (...names: string[]) => args.some((a) => names.includes(a));
if (has("--help", "-h")) {
  process.stdout.write(HELP);
} else if (has("--version", "-V", "-v")) {
  process.stdout.write(`${VERSION}\n`);
} else if (args.length > 0) {
  process.stderr.write(`unknown argument "${args[0]}"\nRun "agentic-realtime-mcp --help" for usage.\n`);
  process.exit(2);
} else {
  // Loaded only when serving, so --help and --version never pay for the server's imports.
  import("./mcp.js")
    .then(({ startMcp }) => startMcp())
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
