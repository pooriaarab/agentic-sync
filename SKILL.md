---
name: agentic-sync
description: Live edits for people and agents on one document, with offline support. Keywords: yjs,crdt,realtime,collaboration,presence,offline,agents,durable-objects,cloudflare,mcp.
---

# agentic-sync

Live edits for people and agents on one document, with offline support.

## Use the Worker

```ts
import { createSyncWorker } from "agentic-sync/worker";
export { SyncRoom } from "agentic-sync/worker";

export default createSyncWorker({ authorize: myAuthorize });
```

Connect a Yjs client to `/api/v1/docs/:id/ws`. Read `/api/v1/docs/:id` for
the contributors and their kinds.

## Rules

- The host owns auth. Pass an `authorize` hook.
- Read-only roles cannot write. The server drops their updates.
- Label agent edits by principal kind. Never hide that an agent wrote them.
