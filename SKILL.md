---
name: agentic-realtime
description: "Live edits for people and agents on one document, with offline support. Keywords: yjs,crdt,realtime,collaboration,presence,offline,agents,durable-objects,cloudflare,mcp."
---

# agentic-realtime

Live edits for people and agents on one document, with offline support.

## Use the Worker

```ts
import { createSyncWorker } from "agentic-realtime/worker";
export { SyncRoom } from "agentic-realtime/worker";

export default createSyncWorker({ authorize: myAuthorize });
```

Connect a Yjs client to `/api/v1/docs/:id/ws`. Read `/api/v1/docs/:id` for
the contributors and their kinds.

## Use the CLI or MCP

Set `AGENTIC_SYNC_URL` and `AGENTIC_SYNC_TOKEN`. Then run
`agentic-realtime doc apply --doc <id> --root body --text "..."`, or start
`agentic-realtime mcp` and call `doc_get`, `doc_apply`, `doc_snapshot`,
`doc_snapshots`, `doc_restore`, and `doc_presence`.

## Rules

- The host owns auth. Pass an `authorize` hook.
- Read-only roles cannot write. The server drops their updates.
- Label agent edits by principal kind. Never hide that an agent wrote them.
