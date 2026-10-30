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
`doc_snapshots`, `doc_restore`, `doc_blame`, `doc_export`, and `doc_presence`.
Owners can run `agentic-realtime doc export --doc <id>` or call `doc_export`
to read stored history as a JSON array. Owners delete with `doc delete --doc <id> --confirm <id>` or MCP `doc_delete`
with matching `doc` and `confirm`. Never give an agent the host secret.

## Rules

- The host owns auth. Pass an `authorize` hook.
- Read-only roles cannot write. The server drops their updates.
- Label agent edits by principal kind. Never hide that an agent wrote them.

Host operators set AGENTIC_SYNC_ADMIN_SECRET for CLI `admin export|delete|revoke|role`.
Use --doc, --confirm for delete, --principal for revoke/role, and --role with
owner|editor|commenter|viewer|null. All commands print JSON and accept --help.
MCP host tools require AGENTIC_SYNC_ENABLE_ADMIN=1: admin_export, admin_delete,
admin_revoke, admin_role. Schemas use doc, confirm, principalId, role.
Only use this mode in a trusted host operator session. Credentials stay in the
server environment. The Worker checks authority. Never give an agent the host secret.
SDK createDocumentClient({ server, token }) and createAdminClient({ server, secret })
provide typed methods for the same routes. null lifts a role cap or revoke.
