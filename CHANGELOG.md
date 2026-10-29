# Changelog

## Unreleased

- Peer colors are `#rrggbb` and pass WCAG 2.2 AA contrast. The default color
  has 3:1 on a white page and on a `#121212` page. `peerColor` also gives 4.5:1
  text colors for one page. `client.peers` replaces a color that is not
  `#rrggbb` or is hard to see. New exports: `peerColor`, `safePeerColor`,
  `contrastRatio`, `isHexColor`, and the contrast constants.
- Peer names use a closed character set, with a 40 character cap. The set is
  letters, digits, marks, spaces, and `. _ ' ’ ( ) -`. Emoji and `@` are out.
  The client now throws for another name: change `--name` and
  `AGENTIC_SYNC_NAME` values that use them. The server drops an unsafe name
  from the presence it relays and keeps the socket, so older clients keep
  working. A host name from `authorize` follows the same set: peers show
  `Unknown` for another one. New exports: `isSafePeerName`,
  `assertSafePeerName`, `displayPeerName`, `MAX_NAME_LENGTH`, `FALLBACK_NAME`.

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
