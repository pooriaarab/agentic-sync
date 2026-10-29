#!/usr/bin/env node
import { VERSION } from "./version.js";

const HELP = `agentic-realtime-mcp ${VERSION}
Usage: agentic-realtime-mcp [--help | --version]

Runs the MCP server on stdio. An MCP client starts it.
`;

const flag = process.argv[2];
if (flag === "--version" || flag === "-V") {
  process.stdout.write(`${VERSION}\n`);
} else if (flag === "--help" || flag === "-h") {
  process.stdout.write(HELP);
} else {
  // Loaded only when serving, so --help and --version never pay for the server's imports.
  import("./mcp.js")
    .then(({ startMcp }) => startMcp())
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
