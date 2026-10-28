# Security policy

## Report a problem

Use GitHub private vulnerability reporting on
https://github.com/pooriaarab/agentic-sync/security/advisories/new.
Do not open a public issue for a security problem.

We reply within 5 working days. We fix confirmed problems and publish an
advisory with the fix.

## Secure defaults

- The default Worker refuses every request. You must pass an `authorize` hook.
- The package has no default credentials.
- The server never logs document content or personal data.
