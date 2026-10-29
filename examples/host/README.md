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
viewer token can read, and its edits are refused. A caller with a token can also use
the HTTP API with the header `Authorization: Bearer <token>`. This call returns the
role, the update count, and the contributors of a document, not its text:

```sh
curl -H "Authorization: Bearer <agent token>" http://127.0.0.1:8787/api/v1/docs/notes
```

## End a session

Revoke a person or an agent at once with the host secret from `.dev.vars`. This closes
their sockets and refuses them until you lift it:

```sh
curl -X POST -H "Authorization: Bearer <host secret>" -H "content-type: application/json" \
  -d '{"principalId": "bot-1"}' http://127.0.0.1:8787/api/v1/admin/docs/notes/revoke
```

The SDK does the same from your own backend code:

```ts
import { revokePrincipal } from "agentic-realtime/sdk";

const host = { server: "http://127.0.0.1:8787", secret: process.env.SYNC_ADMIN_SECRET! };
await revokePrincipal(host, "notes", "bot-1");
```

To take a token away, delete it from `HOST_TOKENS`. In local dev, restart `npm run example`. In
production, run `wrangler secret put HOST_TOKENS` and deploy. A restart or a deploy also
drops the open sockets, so the person has to sign in again, and the old token fails.

The room also asks `reauthorize` every minute, and this matters when you read your
table from a database that changes while the room runs. In this example the table comes
from a variable, so it changes only with a restart or a deploy. A principal can hold
several tokens, so it keeps the widest role of the tokens that may open the document.
It loses access when the table lists none for that document.

## Limits

- The example reads a token from the `Authorization` header only. A browser cannot
  set that header on a WebSocket. Mint a short-lived ticket in your own backend and
  read it in `authorize`.
- Tokens live in one variable. Use a database or your identity provider in production.
- Every grant is the same for each document. Add your own rules in `authorize`.
