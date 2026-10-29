export const PRINCIPAL_KINDS = [
  "human",
  "agent_of_human",
  "agent_of_agent",
  "agent",
  "user_token",
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const ROLES = ["owner", "editor", "commenter", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  id: string;
  kind: PrincipalKind;
}

export interface Grant {
  principal: Principal;
  role: Role;
  // A display name the host vouches for. Presence shows it in place of
  // whatever name the client sends.
  name?: string;
}

// A host-set limit on one principal in one document. A cap only narrows
// the grant: "revoked" removes all access, a role is the most the
// principal may hold.
export type Cap = Role | "revoked";

// Everything a principal may do, after the host's cap. A cap that is not
// a known value counts as revoked, so bad stored data denies access.
export function effectiveRole(granted: Role, cap: unknown): Role | null {
  if (!ROLES.includes(granted)) return null;
  if (cap === undefined) return granted;
  const capIndex = ROLES.indexOf(cap as Role);
  if (capIndex < 0) return null;
  return ROLES[Math.max(ROLES.indexOf(granted), capIndex)];
}

// The host owns auth. It returns a grant for this request and document,
// or null to refuse. This package never reads a credential itself.
export type Authorize = (
  request: Request,
  docId: string,
) => Grant | null | Promise<Grant | null>;

export interface Contributor extends Principal {
  machine: boolean;
}

export interface DocMeta {
  updates: number;
  compactions: number;
  contributors: Contributor[];
}

export interface SnapshotInfo {
  name: string;
  at: number;
  bytes: number;
  author: Contributor;
}

export const MAX_PRINCIPAL_ID_LENGTH = 256;
export const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
export const MAX_SNAPSHOTS = 50;

// The sync server port. The Cloudflare adapter uses Durable Objects.
// A Node Yjs server on any host can implement the same two methods.
export interface Realtime {
  connect(docId: string, request: Request, grant: Grant): Promise<Response>;
  meta(docId: string): Promise<DocMeta>;
  // Null if the name is taken or the document holds the most snapshots.
  createSnapshot(docId: string, name: string, author: Principal): Promise<SnapshotInfo | null>;
  listSnapshots(docId: string): Promise<SnapshotInfo[]>;
  // The saved state as a Yjs update, or null.
  getSnapshot(docId: string, name: string): Promise<Uint8Array | null>;
  // Closes every socket of the principal and refuses it from now on.
  // The sockets close even when the document holds the most caps. Then
  // `stored` is false and a new connection is not refused.
  revoke(docId: string, principalId: string): Promise<{ closed: number; stored: boolean }>;
  // Caps the principal's role, also on sockets that are open now. A null
  // role lifts the cap or the ban. Returns false when the document holds the
  // most caps.
  updateRole(docId: string, principalId: string, role: Role | null): Promise<boolean>;
  // The principal's role after the cap, or null when it is revoked.
  roleFor(docId: string, grant: Grant): Promise<Role | null>;
}

// Role caps and bans count apart, so role caps never stop a revoke.
export const MAX_CAPS = 1000;
export const MAX_REVOKED = 10_000;

export const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function canWrite(role: Role): boolean {
  return role === "owner" || role === "editor";
}

// Every principal kind except a person is machine-made.
export function isMachineKind(kind: PrincipalKind): boolean {
  return kind !== "human";
}

export function assertGrant(value: unknown): Grant {
  const grant = value as Partial<Grant> | null;
  const principal = grant?.principal;
  if (
    typeof principal?.id !== "string" ||
    principal.id.length === 0 ||
    principal.id.length > MAX_PRINCIPAL_ID_LENGTH ||
    !PRINCIPAL_KINDS.includes(principal.kind as PrincipalKind) ||
    !ROLES.includes(grant?.role as Role) ||
    (grant?.name !== undefined &&
      (typeof grant.name !== "string" || grant.name.length === 0 || grant.name.length > 128))
  ) {
    throw new Error("authorize returned an invalid grant");
  }
  const checked: Grant = {
    principal: { id: principal.id, kind: principal.kind },
    role: grant!.role!,
  };
  if (grant!.name !== undefined) checked.name = grant!.name;
  return checked;
}
