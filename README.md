# agentic-sync

[![npm version](https://img.shields.io/npm/v/agentic-sync)](https://www.npmjs.com/package/agentic-sync)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-sync) · [Source](https://github.com/pooriaarab/agentic-sync) · [Support](https://github.com/pooriaarab/agentic-sync/issues)

Live edits for people and agents on one document, with offline support.

> Status: early. Everything below works and has an end-to-end test. The package
> is not on npm yet, so build it from source.

## Features

- A sync server on Cloudflare Durable Objects. One object holds one document.
- The standard Yjs protocol (`y-websocket`), so a stock Yjs client can connect.
- Presence relay: peers see each other's awareness state. The server sets the
  `kind` of each state from the grant, and the `name` when the grant has one.
  A client cannot change either. The first socket that announces a client id
  owns it. Only that socket, or a new socket of the same principal, can
  update or remove it.
- A headless Node client (`agentic-sync/client`) so an agent can join a document.
- Browser offline support (`agentic-sync/browser`): `openDocument` keeps an
  IndexedDB copy, reconnects with backoff, and merges offline edits. `onPeers`
  and `peerLabel` help any UI show peers, with agents marked as machine-made.
- Version history: `client.snapshot(name)`, `snapshots()`, and `restore(name)`.
  A restore is a new edit by you. No stored update or snapshot changes.
- A CLI and an MCP server, so an agent can join and edit with no code.
- Storage in the object. Updates append to a log. Every 50 updates (set
  `SYNC_COMPACT_EVERY`) the log folds into one snapshot.
- WebSocket hibernation. An idle document costs nothing.
- Roles. Owners and editors write. Commenters and viewers only read. The server
  drops their updates and answers with a permission-denied message.
- Author labels. Each update keeps the kind of principal that wrote it. The
  API lists the contributors and marks the machine-made ones.
- Data residency. Set `SYNC_JURISDICTION=eu` to pin documents to the EU.
- No outbound calls. The server loads no CDN assets and sends no telemetry.

## Use the Worker

You own sign-in. Pass an `authorize` hook. It returns a grant, or `null` to
refuse.

```ts
import { createSyncWorker } from "agentic-sync/worker";
export { SyncRoom } from "agentic-sync/worker";

export default createSyncWorker({
  authorize: async (request, docId) => {
    const user = await mySession(request); // your code
    if (!user) return null;
    return {
      principal: { id: user.id, kind: "human" },
      role: await myRoleFor(user, docId), // owner, editor, commenter, viewer
      name: user.displayName, // optional. Shown in presence in place of the client's name.
    };
  },
});
```

Copy `wrangler.jsonc` for the Durable Object binding and the migration.

| Route | Use |
| --- | --- |
| `GET /api/v1/docs/:id/ws` | Upgrade to a WebSocket. Speaks the Yjs protocol. |
| `GET /api/v1/docs/:id` | Read the role, jurisdiction, update count, compaction count, and contributors. |
| `GET/POST /api/v1/docs/:id/snapshots` | List snapshots, or save one (editors only). |
| `GET /api/v1/docs/:id/snapshots/:name` | Read a snapshot as a Yjs update. |
| `GET /health` | Check that the Worker runs. |

A document id matches `[A-Za-z0-9_-]{1,128}`. Ids are case sensitive.

An agent kind is one of `agent_of_human`, `agent_of_agent`, `agent`, or
`user_token`. Only `human` is not machine-made.

## Join a document from Node

```ts
import { SyncClient } from "agentic-sync/client";

const client = await SyncClient.connect({
  url: "wss://sync.example.com/api/v1/docs/notes/ws",
  headers: { authorization: `Bearer ${token}` },
  presence: { name: "Summary bot" },
});
await client.edit((doc) => doc.getText("body").insert(0, "Hello"));
console.log(client.peers); // the other people and agents
await client.disconnect();
```

`connect` resolves when the document matches the server. `edit` and `flush`
resolve when the server has handled your changes. If your role is read-only,
the server drops the edit and `client.denied` holds its reason.

Your presence is `{ name, color, cursor }`. You do not set a `kind`. The server
adds the `kind` of your grant to your presence, so people always see an agent
as an agent. Each peer in `client.peers` carries that `kind`, and `machine` is
true for every kind except a person. Use any Yjs document type on `client.doc`.
The client needs Node 22 or later. It reconnects only if you pass `reconnect: {}`.

## Use the CLI

```sh
export AGENTIC_SYNC_URL=https://sync.example.com
export AGENTIC_SYNC_TOKEN=...   # sent as a bearer token
agentic-sync doc apply --doc notes --root body --text "Hello"
agentic-sync doc get --doc notes
agentic-sync doc snapshot --doc notes --name before-review
agentic-sync doc restore --doc notes --name before-review
agentic-sync doc presence --doc notes
```

Each command joins the document, does one job, prints JSON, and leaves. `doc
snapshot` without `--name` lists the snapshots. A refused edit exits with 1 and
prints the reason. `--kind` and `--name` set how you show in presence. They do
not set your role or author label. The server takes those from the token.

## Use the MCP server

`agentic-sync mcp` serves these tools over stdio: `doc_get`, `doc_apply`,
`doc_snapshot`, `doc_snapshots`, `doc_restore`, and `doc_presence`. Set
`AGENTIC_SYNC_URL`, `AGENTIC_SYNC_TOKEN`, and optionally `AGENTIC_SYNC_NAME` and
`AGENTIC_SYNC_KIND` in the server environment. A tool call never carries a
credential. The same operations are in `agentic-sync/sdk`.

## Work offline in the browser

```ts
import { openDocument, peerLabel } from "agentic-sync/browser";

const { client } = await openDocument({
  url: "wss://sync.example.com/api/v1/docs/notes/ws?ticket=...",
  storageName: "notes",
  presence: { name: "Ana", kind: "human" },
});
client.onPeers((peers) => render(peers.map(peerLabel)));
```

`openDocument` loads the IndexedDB copy first. It then connects and reconnects
after a drop, with delays that double from 500 ms up to 30 s. `onPeers` works in
any UI framework. `peerLabel` names an agent as machine-made.

## Protocol

The WebSocket carries the `y-websocket` messages: sync (type 0), awareness (1),
auth (2), and query awareness (3). A read-only role gets an auth
permission-denied reply, and the server drops its update. The server answers in
order, so its reply to a new sync request proves it has all earlier updates.
`flush` relies on that. A restore is a normal update.

## Swap the server

The Worker talks to the server through the `Realtime` interface. It has five
methods: `connect`, `meta`, `createSnapshot`, `listSnapshots`, and
`getSnapshot`. The Cloudflare adapter implements it with Durable Objects. A Node Yjs server on an EU host can implement it too. The wire
protocol helpers in `agentic-sync` (`readMessage`, `AwarenessRelay`) are plain
TypeScript with no Cloudflare code.

## Limits

- One snapshot or update must stay under 2 MB (Durable Object storage limit).
  The server closes a connection that sends a message over 1 MiB. It refuses
  an update that would take the document past 1.5 MiB, and answers with a
  permission-denied message.
- Presence limits: one socket owns up to 8 client ids, all sockets of one
  principal together own up to 16, and one document holds up to 256 presence
  entries. One state is up to 8192 characters. A socket that breaks a limit,
  sends a state that is not a JSON object, or uses an id that belongs to
  another principal gets closed with code 1008.
- A full document refuses new presence entries. The socket stays open and
  document sync keeps working. The server sends a permission-denied message
  with the reason `presence is full`. Entries that already exist keep updating.
- A new socket of the same principal can take over a client id. The server
  closes the old socket with code 4001. This lets a client reconnect before the
  server notices that the old connection is dead.
- A jurisdiction is part of the object id. Set it before the first write.
  Changing it later points at an empty document.
- A snapshot is a full copy of the state. A document keeps at most 50.
- Restore replaces each root type (text, map, array, XML) and keeps text
  formatting. The CLI and MCP tools edit text roots. Use the client for others.
- The IndexedDB tests run on `fake-indexeddb` in Node, not in a real browser.
- Presence lives in memory. After a hibernation the server forgets it until the
  clients send their next heartbeat, within about 15 seconds.
- The server stores the author of each update. After compaction it keeps the
  set of all authors, not the author of each single update.
- The grant is fixed for the life of a socket. A role change or a revocation
  applies when the client reconnects.
- The local `wrangler dev` cannot place objects in a jurisdiction. Test
  placement on a deployed Worker.
- If you sign in with cookies, check the `Origin` header in `authorize`.

## Develop

Run these on a machine you trust. The end-to-end test starts `wrangler dev`.

```sh
npm ci
npm run ci:local
```

## License

MIT.
