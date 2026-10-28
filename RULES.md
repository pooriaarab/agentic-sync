# agentic-sync rules

These rules bind every run of agentic-sync. They also bind
agents that drive this pack over MCP.

1. Preview before you act. Run each dispatch with dry run first.
2. Respect guards. A denied call stays denied.
3. Report failures as failures. Adapters throw, and callers surface
   the error. No silent success follows a failed call.
4. Count the cost. Read the cost report before you close a task.
5. Keep quiet hours. The pack refuses routes inside the window.

Pack: Live edits for people and agents on one document, with offline support. Keywords: yjs,crdt,realtime,collaboration,presence,offline,agents,durable-objects,cloudflare,mcp.
