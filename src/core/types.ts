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

// The sync server port. The Cloudflare adapter uses Durable Objects.
// A Node Yjs server on any host can implement the same two methods.
export interface Realtime {
  connect(docId: string, request: Request, grant: Grant): Promise<Response>;
  meta(docId: string): Promise<DocMeta>;
}

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
