# agentic-realtime agent guide

Live edits for people and agents on one document, with offline support.

## Mental model

One Durable Object holds one Yjs document. Clients connect over a WebSocket
and speak the standard `y-websocket` protocol. The host app decides who may
connect and with what role.

## What exists now

- `agentic-realtime/worker`: `createSyncWorker({ authorize })` and `SyncRoom`.
- `agentic-realtime/client`: `SyncClient` (`connect`, `edit`, `peers`, `snapshot`, `restore`,
  `exportDocument`, `deleteDocument`, `revokePrincipal`, `setPrincipalRole`).
- `agentic-realtime/browser`: `openDocument` (IndexedDB, reconnect) and `peerLabel`.
- `agentic-realtime`: protocol helpers, the `Realtime` interface, and the types.
- `agentic-realtime` CLI and `agentic-realtime mcp`: `doc get|apply|snapshot|restore|presence|blame|export`.
- `examples/host`: a runnable host with token sign-in. `npm run example`.
- `agentic-realtime/sdk`: the same operations as functions, and the host calls
  `revokePrincipal`, `setPrincipalRole`, `exportDocumentAsHost`, `deleteDocumentAsHost`, and
  the owner calls `exportDocument` and `deleteDocument`. Only owner export is in
  the CLI and MCP. Delete, revoke, and role changes stay client/SDK-only.
  An agent must not hold the host secret.

## Rules

- Do not add auth to this package. The host passes `authorize`.
- Keep Cloudflare code in `src/cloudflare/` and `src/worker.ts`. Keep `src/core/`
  free of it, so a Node server can reuse it.
- Keep the author kind on every stored update and snapshot.
- Make no outbound calls. No CDN, no analytics, no telemetry.
- Never lowercase a document id or snapshot name. Restore is a new update: never rewrite history.
- Never log document content or personal data.
- Test with the end-to-end suite in `e2e/`. It runs the real Worker.
