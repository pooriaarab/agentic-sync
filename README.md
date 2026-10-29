# agentic-realtime

[![npm version](https://img.shields.io/npm/v/agentic-realtime)](https://www.npmjs.com/package/agentic-realtime)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-realtime) · [Source](https://github.com/pooriaarab/agentic-sync) · [Support](https://github.com/pooriaarab/agentic-sync/issues)

Live edits for people and agents on one document, with offline support.

> Status: 0.2.0 preview. Most features below have an end-to-end test.
> Hibernation, the no-outbound-calls rule, and EU placement do not.

## Install

```sh
npm install agentic-realtime
```

## Features

- A sync server on Cloudflare Durable Objects. One object holds one document.
- The standard Yjs protocol (`y-websocket`), so a stock Yjs client can connect.
- Presence relay: peers see each other's awareness state. The server sets the
  `kind` of each state from the grant, and the `name` when the grant has one.
  A client cannot change either. The first socket that announces a client id
  owns it. Only that socket, or a new socket of the same principal, can
  update or remove it.
- A headless Node client (`agentic-realtime/client`) so an agent can join a document.
- Browser offline support (`agentic-realtime/browser`): `openDocument` keeps an
  IndexedDB copy, reconnects with backoff, and merges offline edits. `onPeers`
  and `peerLabel` help any UI show peers, with agents marked as machine-made.
- Version history: `client.snapshot(name)`, `snapshots()`, and `restore(name)`.
  A restore is a new edit by you. No stored update or snapshot changes.
- A CLI and an MCP server, so an agent can join and edit with no code.
- Storage in the object. Updates append to a log. Every 50 updates (set
  `SYNC_COMPACT_EVERY`, from 1 to 128) the log folds into one snapshot.
- WebSocket hibernation. An idle document uses no compute.
- Roles. Owners and editors write. Commenters and viewers only read. The server
  drops their updates and answers with a permission-denied message.
- Author labels. Each update keeps the kind of principal that wrote it. The
  API lists the contributors and marks the machine-made ones.
- Who wrote what. A log keeps which principal sent which content, also after
  compaction and inside each snapshot. `blame` shows it as runs of text, with
  agents marked as machine-made.
- Delete and export. The owner or the host can export the full stored history
  of a document, and delete all of its data.
- Live revocation. The host can revoke a principal or cap its role while it is
  connected. A timer asks the host again who each socket is.
- Data residency. Set `SYNC_JURISDICTION=eu` to pin documents to the EU.
- No outbound calls. The server loads no CDN assets and sends no telemetry.

## Use the Worker

You own sign-in. Pass an `authorize` hook. It returns a grant, or `null` to
refuse.

```ts
import { createSyncWorker } from "agentic-realtime/worker";
export { SyncRoom } from "agentic-realtime/worker";

export default createSyncWorker({
  authorize: async (request, docId) => {
    const user = await mySession(request); // your code
    if (!user) return null;
    return {
      principal: { id: user.id, kind: "human" },
      role: await myRoleFor(user, docId), // owner, editor, commenter, viewer
      name: user.displayName, // optional. Shown in presence in place of the client's name. Use the safe set for names.
    };
  },
});
```

`authorize` also gets the Worker `env` as its third argument, for the secrets of your
sign-in. Copy `wrangler.jsonc` for the Durable Object binding and the migration.
The default Worker refuses every document. To see a working host, run
[`examples/host`](examples/host/README.md). It signs callers in with bearer tokens.

| Route | Use |
| --- | --- |
| `GET /api/v1/docs/:id/ws` | Upgrade to a WebSocket. Speaks the Yjs protocol. |
| `GET /api/v1/docs/:id` | Read the role, jurisdiction, update count, compaction count, and contributors. |
| `GET/POST /api/v1/docs/:id/snapshots` | List snapshots, or save one (editors only). |
| `GET /api/v1/docs/:id/snapshots/:name` | Read a snapshot as a Yjs update. |
| `GET /api/v1/docs/:id/attribution` | Read who sent which content. Any role may read it. |
| `GET /api/v1/docs/:id/snapshots/:name/attribution` | The same log, as of that snapshot. |
| `GET /api/v1/docs/:id/export` | Stream everything stored for the document as JSON lines. Owners only. |
| `DELETE /api/v1/docs/:id` | Delete all data of the document. Owners only. The body is `{"confirm": "<id>"}`. |
| `GET /api/v1/admin/docs/:id/export`, `DELETE /api/v1/admin/docs/:id` | The same two calls for the host, with the host secret. |
| `GET /health` | Check that the Worker runs. |

A document id matches `[A-Za-z0-9_-]{1,128}`. Ids are case sensitive.

An agent kind is one of `agent_of_human`, `agent_of_agent`, `agent`, or
`user_token`. Only `human` is not machine-made.

## Revoke access while people are connected

A grant is checked when a socket opens. Two paths change it after that.

**Host calls.** Set `SYNC_ADMIN_SECRET` (at least 32 bytes) as a Worker secret.
The host then calls the admin routes with `Authorization: Bearer <secret>`. Keep
the secret in your backend. Never give it to an agent.

```ts
import { revokePrincipal, setPrincipalRole } from "agentic-realtime/sdk";

const host = { server: "https://sync.example.com", secret: env.SYNC_ADMIN_SECRET };
await setPrincipalRole(host, "notes", "person-1", "viewer"); // read-only at once
await revokePrincipal(host, "notes", "person-1"); // closes every socket, code 4003
await setPrincipalRole(host, "notes", "person-1", null); // lifts the cap or the revoke
```

A cap only narrows. The principal gets the narrower of the grant and the cap.
A revoked principal gets `403 ACCESS_REVOKED` on every route, also for
snapshots, until the host lifts the revoke. The cap lives in the document's
storage. A cap is keyed by principal id, so keep ids unique across kinds. A
principal id is at most 256 characters. One document holds up to 1000 role caps and
up to 10000 bans, counted apart, so a full table of role caps never stops a
revoke. Past the ban limit, a revoke still closes the sockets, but it answers
`409 CAP_LIMIT` because no ban is stored. A cap of `owner` narrows nothing,
so the server drops it. That also lifts a revoke, the same as `null`. Without a valid secret,
the admin routes answer `503 ADMIN_DISABLED`. A Worker of your own can call the same
methods through the `Realtime` port, or by Durable Object RPC on `SyncRoom`.

**Timer.** Export a room class that knows how to ask your host:

```ts
import { createSyncRoom } from "agentic-realtime/worker";

export const SyncRoom = createSyncRoom({
  // The principal's current role, or null for no access.
  reauthorize: async (principal, docId) => myRoleFor(principal.id, docId),
});
```

Every 60 seconds (set `SYNC_REAUTH_INTERVAL_SECONDS`, 1 to 3600) the room asks
once for each connected principal, up to 20 calls at a time, each with a 5
second limit. The new role can only narrow the role granted at connect, so the
timer never widens access. It applies to all sockets of that principal. A `null`,
a throw, a timeout, or an unknown role closes them with code 4003. A host outage
therefore ends the sessions. It does not keep them open. A host that answers
slower than 5 seconds has the same effect, and every client then reconnects at
once, so size your host for that.

## Join a document from Node

```ts
import { SyncClient } from "agentic-realtime/client";

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

Your presence is `{ name, color, cursor }`. The default `color` comes from your
name and has at least 3:1 contrast on a white page and on a dark page (`#121212`).
`peerColor(name, "light" | "dark")` gives a color with 4.5:1 text contrast on one
page. No single color has 4.5:1 on both. `client.peers` keeps a peer's color only
if it is `#rrggbb` with 3:1 on both pages. Otherwise it uses the peer's default. You do not set a `kind`. The server
adds the `kind` of your grant to your presence, so people always see an agent
as an agent. Each peer in `client.peers` carries that `kind`, and `machine` is
true for every kind except a person. A name has 1 to 40 letters, digits, spaces,
`’`, or `. _ ' ( ) -`. It has no bidi controls, zero-width characters, or other
invisible characters. The client throws for any other name (it first converts
a name to NFC). The server drops an unsafe name from the presence it relays,
and peers show `Unknown`. The socket stays open. The set does not stop
look-alike letters from other scripts. Show a name in an isolated run
(`<bdi>` or `dir="auto"`), because right-to-left letters are allowed. Check a name with `isSafePeerName`. Use any Yjs document type on `client.doc`.
The client needs Node 22 or later. It reconnects only if you pass `reconnect: {}`.

## Use the CLI

```sh
export AGENTIC_SYNC_URL=https://sync.example.com
export AGENTIC_SYNC_TOKEN=...   # sent as a bearer token
agentic-realtime doc apply --doc notes --root body --text "Hello"
agentic-realtime doc get --doc notes
agentic-realtime doc snapshot --doc notes --name before-review
agentic-realtime doc restore --doc notes --name before-review
agentic-realtime doc presence --doc notes
agentic-realtime doc blame --doc notes --root body
```

Each command joins the document, does one job, prints JSON, and leaves. `doc
snapshot` without `--name` lists the snapshots. A refused edit exits with 1 and
prints the reason. `--name` sets the name you show in presence. The server takes
your role, your kind, and your author label from the token. The CLI has no
`--kind` flag. `doc apply` edits text roots and empty roots only. It refuses a
rich-text, map, or array root and exits with 1, so it never deletes a document.

## Use the MCP server

`agentic-realtime mcp` serves these tools over stdio: `doc_get`, `doc_apply`,
`doc_snapshot`, `doc_snapshots`, `doc_restore`, `doc_blame`, and `doc_presence`. Set
`AGENTIC_SYNC_URL`, `AGENTIC_SYNC_TOKEN`, and optionally `AGENTIC_SYNC_NAME` in
the server environment. A tool call never carries a credential. `doc_apply`
returns an error for a root that is not text. The same operations are in `agentic-realtime/sdk`.

## Export and delete a document

An owner, or the host with the host secret, can take a copy of a document and
delete it.

```ts
import { deleteDocument, exportDocument } from "agentic-realtime/sdk";

const records = await exportDocument({ server, token: ownerToken }, "notes");
await deleteDocument({ server, token: ownerToken }, "notes"); // cannot be undone
```

`exportDocumentAsHost` and `deleteDocumentAsHost` take `{ server, secret }` instead. An
export is JSON lines, one record each, sent as the room reads its storage:

| `type` | Holds |
| --- | --- |
| `meta` | `format` (`agentic-realtime-export`), `version`, `exportedAt`, `compactions`, and the base. |
| `state` | `base64`: the whole document as one Yjs update. |
| `roots` | Each root type as plain JSON. |
| `authors` | Everyone who wrote, with a `machine` label. |
| `caps` | The host's caps and bans: `principalId` and `cap`, a role or `revoked`. It can name principals who never wrote, and owners can read it. |
| `attribution` | The log of who sent which content. |
| `update` | One update that compaction has not folded yet: `seq`, `at`, `author`, `base64`. |
| `snapshot` | A named snapshot: `name`, `at`, `bytes`, `author`, `base64`, and its `attribution`. `base64` and `attribution` are `null` when the stored state or log is missing. |

A delete closes every socket with code 4004. It removes the updates, the base, the
snapshots, the attribution logs, the caps and bans, and the timer. The document id
then starts empty, and a new writer starts a new history. A delete needs `confirm`
with the document id in its body, so a stray call does nothing.

The package has no CLI or MCP command for either call, as for a revoke. An agent
must not delete a document, and it must not hold the host secret.

## See who wrote what

Yjs names each piece of content by a client id and a clock. The room keeps a
log of ranges: which principal (id and kind) sent each run of those names. It
folds contiguous writes of one client into one range. It saves the log with
every compaction, and each named snapshot keeps a copy.

```ts
import { blame } from "agentic-realtime/sdk";

const spans = await blame({ server, token }, "notes", "body");
// [{ text: "Hi ", author: { id: "p1", kind: "human", machine: false } },
//  { text: "bot", author: { id: "a1", kind: "agent_of_human", machine: true } }]
await blame({ server, token }, "notes", "body", "before-review"); // as of a snapshot
```

`author` is `null` for text that no range names. `getAttribution` returns the raw
log: `authors`, `ranges`, `dropped`, and `lost`. The machine label comes from the kind, never from storage.

## Work offline in the browser

```ts
import { openDocument, peerLabel } from "agentic-realtime/browser";

const { client } = await openDocument({
  url: "wss://sync.example.com/api/v1/docs/notes/ws?ticket=...",
  storageName: "notes",
  presence: { name: "Ana" },
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

The Worker talks to the server through the `Realtime` interface. It has eleven
methods: `connect`, `meta`, `createSnapshot`, `listSnapshots`, `getSnapshot`,
`revoke`, `updateRole`, `roleFor`, `erase`, `exportHistory`, and `attribution`.
The Cloudflare adapter implements it with Durable Objects. Another server, such as
a Node Yjs server, could implement it. See the changelog for what 0.2.0 added. The wire
protocol helpers in `agentic-realtime` (`readMessage`, `AwarenessRelay`) are plain
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
- The attribution log keeps up to 4000 ranges (set `SYNC_ATTRIBUTION_MAX_RANGES`,
  4 to 5000), and also stays under about 1.5 MB with the ids of its authors. Each new client id starts a range, so a client that reconnects
  often uses them fast. Past the limit the oldest ranges go, `dropped` counts
  them, and their text shows as unattributed. The log is not a signed record.
- A restore matches text by item in the Yjs history, never by letter. A piece
  that the live text and the snapshot both hold keeps its author, and a restore
  that only removes formatting changes no author. Text that a restore brings back is
  new text by the person who restored it. An undo that brings back deleted
  text does the same.
- Yjs holds an update that needs missing content, and applies it inside the next
  update. The room refuses such an update and closes the socket with code 1008.
  It also refuses an update that writes under the client id of another principal.
  This check forgets a client id once the size limit drops its ranges. A client
  that keeps its `Y.Doc` and signs in as another principal writes under the old
  client id, so the room refuses it. Make a new `Y.Doc` when the principal changes.
- `lost: true` in the log means the saved log was damaged. The document still
  loads. Text from before the damage has no author.
- The log names who sent an insert. It does not name who deleted. It covers text
  roots. Content that a document held before this version has no range until
  someone rewrites it. A snapshot made before this version has no log, and
  its attribution answers 404.
- The author of a range is the principal that sent the update. A principal can
  send a range of ids that nobody has used yet. The first range recorded for
  an id wins, so a later sender cannot take over text that is already there.
- A delete removes the room's storage. It cannot remove copies that other
  parties hold: an export, a snapshot a client downloaded, the offline copy in a
  browser, your backups, and your host's logs. A client with an offline copy
  writes it back when it reconnects, so make `authorize` refuse a deleted
  document, or revoke its principals. Record a delete in your own audit log.
- An export is not a point in time. A write during the stream may or may not be in
  it. Compaction has folded older updates into the state, so an export lists only
  the updates since the last compaction. The snapshots and the attribution log
  keep who wrote what. An export holds the content in clear text, so treat the file
  as personal data.
- Revocation by the host call is immediate. Revocation by the timer takes up to
  one interval. Without `createSyncRoom`, there is no timer. A room with open
  sockets from before you deployed `createSyncRoom` starts its timer at the next
  connection.
- A client with `reconnect` keeps retrying after code 4003 and gets 403 each
  time, with growing delays. Stop it in your UI when you revoke.
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
