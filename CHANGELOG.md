# Changelog

## 0.4.3

No breaking changes. Upgrading from 0.4.2 needs no code change.

### Changed

- The package depends on `agentic-identity` `^0.7.0`. It was `^0.6.0`. The principal kinds and the principal id rule do not change.

### Fixed

- `mcp --help`, `mcp -h`, `mcp --version`, and `mcp -V` print and exit 0. They never start the server. `agentic-realtime-mcp` also takes `-v` for the version.
- `mcp` with an argument it does not know, and `agentic-realtime-mcp` with an unknown flag, exit 2 with a message. They never start the server.

### Internal

- Publish runs on one ref wait for each other. A running publish is not cancelled.

## 0.4.2

Breaking for principal ids outside the `agentic-identity` rule. Read the first
item under Changed before you upgrade from 0.4.1. The other changes need no code
change.

### Changed

- Breaking for ids outside the rule. A principal id must match the
  `agentic-identity` rule: 1 to 128 ASCII characters, first an ASCII letter,
  digit, `_` or `-`, then ASCII letters, digits, `.`, `_` or `-`. Before, any
  id of up to 256 characters passed. A grant with another id fails with HTTP
  500. The admin routes (revoke and role) refuse it with
  `INVALID_PRINCIPAL_ID`. A direct `revoke` or `updateRole` call on the
  Realtime port throws a `TypeError`.
- Before you upgrade, map your ids to the rule in `authorize`. Lift every cap
  and ban stored under an id that breaks the rule. The admin routes refuse that
  id after the upgrade, and a slot held by such an entry clears only when the
  document is deleted. To close an open socket of such an id, revoke it, then
  lift the revoke with a role of `null` just before you deploy. Otherwise the
  ban stays and holds a slot. A socket that opened before the upgrade stays
  open until it reconnects.
- `PRINCIPAL_KINDS` and `PrincipalKind` come from `agentic-identity`. The names
  and types do not change.
- The principal id check comes from `agentic-identity` too. A grant, the admin
  routes, and `setCap` all use the same rule.

### Removed

- The package's own copy of the principal kinds and of the principal id check.
  The `MAX_PRINCIPAL_ID_LENGTH` constant is gone. The package did not export it.

## 0.4.1

No breaking changes. Upgrading from 0.4.0 needs no code change.

### Fixed

- `agentic-realtime-mcp --help` and `-h` print the usage. `--version` and `-V`
  print the package version. Both exit without starting the MCP server, so an
  install check no longer waits on stdin.

### Docs

- The README lists every export of each entry point: the main entry, `/sdk`,
  `/client`, `/browser`, `/worker`, and `/firestore`.

## 0.4.0

No breaking changes. Upgrading from 0.3.0 needs no code change.

### Added

- `RoomStorage`, a key/value port for a room's stored data: `get`, `list` by
  prefix, `put`, `putAll`, `delete`, and `deleteAll`. The package exports the
  type, `createMemoryStorage`, and `exportStorage`, which streams the stored
  data as JSON lines.
- `agentic-realtime/firestore`: `createFirestoreStorage({ projectId, docId, fetch,
  token })` stores a document in Firestore over the REST API. It has no Firebase
  SDK and no secret of its own. It implements `RoomStorage`. The room does not
  use the port yet, so nothing runs on Firebase today. See "Run on Firebase" in
  the README for the limits: a key is up to 1000 bytes, a value is under 1 MB as
  JSON, and `putAll` takes up to 500 entries.

### Docs

- `llms.txt` describes authorship: which principal sent each run of text, how
  compaction and snapshots keep that log, and how to read it with `blame`.

## 0.3.0

Read the breaking changes before you upgrade. Check every peer name your code
sends first: `presence.name` in `SyncClient.connect` and `openDocument`, the
`name` of `setPresence`, the `name` of the SDK target, and the `--name` and
`AGENTIC_SYNC_NAME` values of the CLI and MCP server. A peer name must start with
a letter or a digit, have 40 characters or fewer, and have no leading, trailing,
or double space. To check a name before you pass it, call `isSafePeerName` on
its NFC form: `isSafePeerName(name.normalize("NFC"))`.

### Breaking

- Peer names use a closed character set, with a 40 character cap. The set is
  letters, digits, marks, spaces, and `. _ ' ’ ( ) -`. Emoji and `@` are out.
  The client now throws for another name, in `SyncClient.connect`, `setPresence`,
  `openDocument`, and the SDK, as well as in the CLI and MCP server. Change each
  name that uses other characters. A name must also start with a
  letter or a digit, have no leading, trailing, or double space, and have at
  most 3 combining marks in a row. Invisible characters are out. The server
  drops an unsafe name from the presence it relays and keeps the socket. An
  older client keeps its socket, but a peer with an unsafe name reaches it with
  no `name`. Upgrade the clients before you rely on a name. A host name from
  `authorize` follows the same set: peers show `Unknown` for another one.
- Peer colors that are not `#rrggbb`, or that are hard to see, are replaced.
  This includes CSS color names and the 0.2.0 default color, which was an
  `hsl(...)` string. A peer shows a different color after you upgrade. To keep
  a color, set a `#rrggbb` color with 3:1 contrast on both pages.
- `Peer` has a new required field, `away`. Code that builds a `Peer` object
  must add it. A `Peer` is no longer assignable to `Presence`, because its
  `away` can be `"unknown"`. Code that passes a peer where a `Presence` is
  expected must change its type.
- `OpenedDocument`, the result of `openDocument`, has a new required field,
  `stopWatching`. Code that builds an `OpenedDocument`, such as a test double,
  must add it. Code that only calls `openDocument` does not change.

### Added

- Presence can carry an away state: `active`, `idle`, or `hidden`. Pass the new
  `away: { idleAfterSeconds }` option with `presence`. Call `client.markActive()`
  on input and `client.setHidden(true | false)` when a page hides or shows.
  The `client.away` getter and the optional `away` field of `Presence` hold the
  state. The server drops an invalid `away` value. Every `Peer` has an `away`
  field that is `unknown` when the peer reports none. New exports: `AwayTracker`,
  `AwayState`, `AwayOptions`, `isAwayState`, `readAwayState`, `AWAY_STATES`,
  `watchPageAway` and `PageLike` (browser), and `stopWatching` on the result of
  `openDocument`.
- Peer colors: `peerColor`, `safePeerColor`, `contrastRatio`, `isHexColor`, the
  `ColorMode` type, and the contrast constants are exported. The default color has 3:1 on a white
  page and on a `#121212` page. `peerColor` also gives 4.5:1 text colors for one
  page.
- Name helpers: `isSafePeerName`, `assertSafePeerName`, `displayPeerName`,
  `MAX_NAME_LENGTH`, and `FALLBACK_NAME`.
- `exportDocumentStream` and `exportDocumentStreamAsHost` in `agentic-realtime/sdk`
  yield the export one record at a time, as the response arrives. Use them for a
  large history. `exportDocument` and `exportDocumentAsHost` keep their return
  value, and they still hold the whole export in memory.

### Changed

- The client converts its own peer name to Unicode NFC before it checks the name.
- In the CLI, `snapshot` and `restore` take `--name` as the snapshot name, not
  as a peer label. Those two commands label the peer `agentic-realtime cli`, so
  a valid snapshot name no longer fails the peer name check.

### Tests

- A closing socket cannot write is also checked over a raw socket. This is a
  test change only, with no API change.

## 0.2.0

This release changes the `Realtime` port. If you wrote your own adapter or host,
read the migration note and the changed list before you upgrade. The Cloudflare adapter,
`createDurableObjectRealtime`, already has every method.

### Breaking

- The `Realtime` port has six methods that 0.1.0 did not have: `revoke`,
  `updateRole`, `roleFor`, `erase`, `exportHistory`, and `attribution`. An
  adapter written for 0.1.0 does not type-check until it adds them.

### Migration for adapter authors

Implement each method below. Import the types (`Realtime`, `Grant`, `Principal`,
`Role`, `DocMeta`, `SnapshotInfo`) from `agentic-realtime`. `attribution` returns
the shape of `AttributionLog.labeled()`, which the package also exports.

- `revoke(docId, principalId)`: close every open socket of the principal, and
  refuse it from now on. Resolve with `{ closed, stored }`. `closed` counts the
  sockets. Sockets close even when the document holds the most bans. Then
  `stored` is `false`, and a new connection is not refused. Report that to the
  host.
- `updateRole(docId, principalId, role)`: cap the principal's role on the
  open sockets too, so a downgraded editor is read-only at once. A `null` role
  lifts the cap or the ban. Resolve with `false` when the document holds the
  most caps.
- `roleFor(docId, grant)`: resolve with the role after the cap, or `null` when
  the principal is revoked. A cap that is not a known role counts as revoked.
  Keep that rule, so bad stored data denies access.
- `erase(docId)`: delete all stored data of the document. That is the updates,
  the base state, the snapshots, the attribution logs, the caps and bans, and
  any timer. Close every open socket of the document. Resolve with
  `{ sockets: number }`, the count of sockets you closed. After that, the
  document id starts empty and a new writer starts a new history.
- `exportHistory(docId)`: resolve with a `ReadableStream<Uint8Array>`. It
  streams JSON lines, one record each, as your storage reads them. The record
  types are in the README under "Export and delete a document". Every `update`
  and `snapshot` record keeps the author kind. Do not drop records, and do not
  label a machine author as a person.
- `attribution(docId, snapshot?)`: resolve with the log of who sent which
  content, now or as of a named snapshot. Resolve with `null` when the snapshot
  has no log.
- Documents that 0.1.0 stored have no attribution log. Blame shows no author for
  text written before 0.2.0, and it does not flag that history is missing.
- An export holds the content in clear text. Treat the stream as personal data.
  Do not log it.
- Test your adapter against the end-to-end suite in `e2e/`. The
  `gdpr.e2e.test.ts` cases cover erase and export.

### Changed

- `Authorize` gets a third argument, `env`, with the Worker bindings and
  variables. Existing hosts still compile.
- A principal id longer than 256 characters makes `assertGrant` throw. The request
  then fails with HTTP 500, as a bad grant did in 0.1.0.
- A snapshot name of `.` or `..` is refused. Names still match
  `SNAPSHOT_NAME_PATTERN`.

### Added

- Live revocation and role caps (see the README features list).
- `createSyncRoom({ reauthorize })` in `agentic-realtime/worker`. It re-checks open
  sockets on a timer. Export it as `SyncRoom` to turn the timer on.
- Worker variables `SYNC_ADMIN_SECRET` (the host calls), `SYNC_REAUTH_INTERVAL_SECONDS`,
  and `SYNC_ATTRIBUTION_MAX_RANGES`.
- Attribution: who sent which content, and `blame` in the SDK and the CLI.
- Export and delete for owners and for the host.
- A runnable example host with token sign-in (`npm run example`).
- The export has a `caps` line. It lists the host's caps and bans, one entry
  per principal, as `principalId` and `cap`. The format `version` stays `1`.
  Ignore line types you do not know.
- `npm run prepack` builds `dist` before `npm pack` and `npm publish`.

### Fixed

- A socket that is closing cannot write into the document. An erase, a
  revoke, or a host call that cuts a principal off closes the socket first.
  Its late updates are dropped.
