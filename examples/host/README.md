# Example host

This Worker shows how to run `agentic-realtime` end to end on your laptop. It signs
callers in with bearer tokens. Copy `worker.ts` and replace the sign-in with your own.

## Run it

Run these in the repository root. The example imports the built package.

```sh
npm ci
npm run build
cp examples/host/.dev.vars.example examples/host/.dev.vars
```

Make one token for each person or agent:

```sh
openssl rand -hex 32
```

Edit `examples/host/.dev.vars`. Put your tokens in `HOST_TOKENS` and a 32-byte secret in
`SYNC_ADMIN_SECRET`. The example file has no real token: the Worker refuses any token
shorter than 32 bytes, and it answers `500` until you set one.

```sh
HOST_TOKENS='{
  "<owner token>": { "principal": { "id": "ana", "kind": "human" }, "role": "owner", "name": "Ana" },
  "<viewer token>": { "principal": { "id": "bo", "kind": "human" }, "role": "viewer" },
  "<agent token>": { "principal": { "id": "bot-1", "kind": "agent_of_human" }, "role": "editor", "docs": ["notes"] }
}'
```

Start the Worker:

```sh
npm run example
```

## Try it

In another terminal, in the repository root:

```sh
export AGENTIC_SYNC_URL=http://127.0.0.1:8787
export AGENTIC_SYNC_TOKEN=<agent token>
node dist/cli.js doc apply --doc notes --root body --text "Hello from an agent"
node dist/cli.js doc get --doc notes
node dist/cli.js doc blame --doc notes --root body   # the agent shows as machine-made
node dist/cli.js doc get --doc other                 # refused: this token is for "notes" only
```

A call with no token, or with a token that is not in `HOST_TOKENS`, gets `401`. The
viewer token can read, and its edits are refused. Anyone can read the same
document with the HTTP API and the header `Authorization: Bearer <token>`.

## End a session

Revoke a person at once with the host secret. This closes their sockets and refuses
them until you lift it:

```ts
import { revokePrincipal } from "agentic-realtime/sdk";

await revokePrincipal({ server: "http://127.0.0.1:8787", secret: SYNC_ADMIN_SECRET }, "notes", "bot-1");
```

Or remove the token from `HOST_TOKENS` and restart. The room asks `reauthorize` every
minute, so those sessions end within a minute.

## Limits

- The example reads a token from the `Authorization` header only. A browser cannot
  set that header on a WebSocket. Mint a short-lived ticket in your own backend and
  read it in `authorize`.
- Tokens live in one variable. Use a database or your identity provider in production.
- Every grant is the same for each document. Add your own rules in `authorize`.
