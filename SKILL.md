---
name: agentic-sync
description: Live edits for people and agents on one document, with offline support. Keywords: yjs,crdt,realtime,collaboration,presence,offline,agents,durable-objects,cloudflare,mcp.
---

# agentic-sync

Live edits for people and agents on one document, with offline support.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-sync";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-sync summary --text "some text"
agentic-sync dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-sync mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
