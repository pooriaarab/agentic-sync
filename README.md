# agentic-sync

[![npm version](https://img.shields.io/npm/v/agentic-sync)](https://www.npmjs.com/package/agentic-sync)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-sync) · [Source](https://github.com/pooriaarab/agentic-sync) · [Support](https://github.com/pooriaarab/agentic-sync/issues)

Live edits for people and agents on one document, with offline support.

> Status: scaffold. This repository holds the starter code only. It is not on npm
> yet, and none of the features below work yet.

## Planned features

- Yjs documents that many people and agents edit at once.
- Live cursors and presence, with agents shown as peers.
- Offline edits in the browser that merge when you reconnect.
- A sync server on Cloudflare Durable Objects, behind a port you can swap.
- Version history with named snapshots and restore.
- A headless client so an agent can join a document from Node.

## Surfaces

One package gives you each way in:

- **Library and SDK**: `import { ... } from "agentic-sync"`.
- **CLI**: `npx agentic-sync --help`.
- **MCP server**: `npx agentic-sync mcp`, for Claude Code and other MCP clients.
- **HTTP API**: a Cloudflare Worker you deploy to your own account.
- **Web UI**: a small app served by the same Worker.

## Develop

```sh
npm ci
npm run build && npm run typecheck && npm test
```

## License

MIT.
