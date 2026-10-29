import { assertGrant, createSyncRoom, createSyncWorker, ROLES, type Grant } from "agentic-realtime/worker";

// An example host. It signs callers in with bearer tokens that you keep in the
// HOST_TOKENS variable (a secret in production). Replace this file with your
// own sign-in. The package never reads a credential itself.
//
// HOST_TOKENS is a JSON object. Each key is a token of at least 32 bytes. Each
// value is a grant, and `docs` limits the token to some documents:
//   { "<token>": { "principal": { "id": "ana", "kind": "human" }, "role": "owner" } }

interface Entry {
  grant: Grant;
  docs?: string[];
}

const sha256 = async (value: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

let loaded: { raw: string; entries: Map<string, Entry> } | undefined;

// Reads the table once per value. The map is keyed by the SHA-256 of each token, so a
// lookup compares hashes of the caller's input and never the token itself.
async function entriesOf(env: Record<string, unknown>): Promise<Map<string, Entry>> {
  const raw = env.HOST_TOKENS;
  if (typeof raw !== "string" || raw === "") throw new Error("set HOST_TOKENS to a JSON object of token to grant");
  if (loaded?.raw === raw) return loaded.entries;
  const entries = new Map<string, Entry>();
  // A parse error quotes a piece of the input, and the input holds the tokens. Say nothing of it.
  let table: unknown;
  try {
    table = JSON.parse(raw);
  } catch {
    throw new Error("HOST_TOKENS is not valid JSON");
  }
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error("HOST_TOKENS must be a JSON object of token to grant");
  }
  for (const [token, value] of Object.entries(table as Record<string, Entry["grant"] & { docs?: unknown }>)) {
    if (new TextEncoder().encode(token).length < 32) throw new Error("every token in HOST_TOKENS must be at least 32 bytes");
    const { docs, ...grant } = value;
    if (docs !== undefined && (!Array.isArray(docs) || docs.some((doc) => typeof doc !== "string"))) {
      throw new Error("docs in HOST_TOKENS must be a list of document ids");
    }
    entries.set(await sha256(token), { grant: assertGrant(grant), docs: docs as string[] | undefined });
  }
  loaded = { raw, entries };
  return entries;
}

const mayOpen = (entry: Entry, docId: string): boolean => entry.docs === undefined || entry.docs.includes(docId);

export default createSyncWorker({
  authorize: async (request, docId, env) => {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return null;
    const entry = (await entriesOf(env)).get(await sha256(token));
    return entry !== undefined && mayOpen(entry, docId) ? entry.grant : null;
  },
});

// Every minute the room asks again who each connected principal is. A
// principal may hold several tokens, so it gets the widest role of those that
// may open the document, and none when no token does.
export const SyncRoom = createSyncRoom({
  reauthorize: async (principal, docId, env) => {
    const roles = [...(await entriesOf(env)).values()]
      .filter(({ grant }) => grant.principal.id === principal.id && grant.principal.kind === principal.kind)
      .filter((entry) => mayOpen(entry, docId))
      .map(({ grant }) => ROLES.indexOf(grant.role));
    return roles.length > 0 ? ROLES[Math.min(...roles)] : null;
  },
});
