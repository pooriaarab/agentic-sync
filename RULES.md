# agentic-sync rules

These rules bind every run of agentic-sync. They also bind agents that edit
a document through it.

1. Connect with a principal. Every edit has an author kind.
2. Respect the role. A read-only role cannot write, and the server drops its updates.
3. Report a permission-denied reply as a failure. Do not retry the same update.
4. Label machine-made edits. Do not change your principal kind.
5. Do not put personal data in presence states.
