import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

const shared = {
  format: ["esm" as const],
  dts: true,
  define: { __PACK_VERSION__: JSON.stringify(pkg.version) },
};

// The worker builds on its own: it needs the Workers types, which clash
// with the Node types the rest of the package uses.
export default defineConfig([
  { ...shared, entry: ["src/index.ts", "src/client/index.ts", "src/browser/index.ts", "src/sdk.ts", "src/firestore/index.ts", "src/cli.ts", "src/mcp.ts", "src/mcp-bin.ts"], tsconfig: "tsconfig.json" },
  {
    ...shared,
    entry: ["src/worker.ts"],
    tsconfig: "tsconfig.worker.json",
    external: ["cloudflare:workers"],
  },
]);
