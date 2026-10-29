# Changelog

## 0.2.0

This release changes the `Realtime` port. If you wrote your own adapter, read
the migration note before you upgrade. The Cloudflare adapter,
`createDurableObjectRealtime`, already has the new methods.

### Breaking

- The `Realtime` port has two new required methods: `erase(docId)` and
  `exportHistory(docId)`. An adapter without them does not type-check.

### Migration for adapter authors

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
- An export holds the content in clear text. Treat the stream as personal data.
  Do not log it.
- Test your adapter against the end-to-end suite in `e2e/`. The
  `gdpr.e2e.test.ts` cases cover erase and export.

### Added

- The export has a `caps` line. It lists the host's caps and bans, one entry
  per principal, as `principalId` and `cap`. The format `version` stays `1`.
  Ignore line types you do not know.
- `npm run prepack` builds `dist` before `npm pack` and `npm publish`.

### Fixed

- A socket that is closing cannot write into the document. An erase, a
  revoke, or a reauthorization closes the socket first, so its late updates
  are dropped.
