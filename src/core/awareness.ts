import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { PrincipalKind } from "./types.js";

export interface AwarenessEntry {
  id: number;
  clock: number;
  state: string;
}

export const MAX_STATE_CHARS = 8192;
export const MAX_IDS_PER_SOCKET = 8;
// All sockets of one principal count together, so one principal cannot
// fill the document. Many principals are needed for that.
export const MAX_IDS_PER_PRINCIPAL = 16;
export const MAX_ENTRIES_PER_DOC = 256;

export function decodeAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  const decoder = decoding.createDecoder(update);
  const entries: AwarenessEntry[] = [];
  for (let n = decoding.readVarUint(decoder); n > 0; n--) {
    entries.push({
      id: decoding.readVarUint(decoder),
      clock: decoding.readVarUint(decoder),
      state: decoding.readVarString(decoder),
    });
  }
  return entries;
}

export function encodeAwarenessUpdate(entries: AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const { id, clock, state } of entries) {
    encoding.writeVarUint(encoder, id);
    encoding.writeVarUint(encoder, clock);
    encoding.writeVarString(encoder, state);
  }
  return encoding.toUint8Array(encoder);
}

// What the server knows about a socket from its grant. It overwrites
// whatever the client claims, so peers can trust these fields.
export interface Identity {
  kind: PrincipalKind;
  name?: string;
}

// Names a socket and the principal behind it.
export interface Owner {
  socket: string;
  principal: string;
}

export interface Applied {
  // The entries to relay, with the identity stamped in.
  accepted: AwarenessEntry[];
  // New entries left out because the document is full.
  refused: number;
  // Sockets that lost a client id to a new socket of the same principal.
  displaced: string[];
}

// A client broke a presence rule. The caller closes its socket.
export class AwarenessViolation extends Error {}

function parseState(state: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    throw new AwarenessViolation("presence state is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AwarenessViolation("presence state is not an object");
  }
  return parsed as Record<string, unknown>;
}

// Server side presence. It holds the latest state per client and does
// not run timers, so a hibernating Durable Object can sleep. Clients
// resend their state on a heartbeat, which refills it after a wake.
//
// The first socket that announces a client id owns it. Only the owner
// can update or remove it. A new socket of the same principal can take
// the id over, as a client does when it reconnects before the server
// sees the old connection die. Each socket owns a few ids, each
// principal owns a few more, and the document holds a few entries, so a
// client cannot grow the relay without bound. A full document refuses
// new entries. It does not punish the socket that sent one.
export class AwarenessRelay {
  private readonly entries = new Map<number, AwarenessEntry>();
  private readonly owners = new Map<number, string>();
  private readonly owned = new Map<string, Set<number>>();
  private readonly principalOf = new Map<string, string>();
  private readonly principalIds = new Map<string, Set<number>>();

  get size(): number {
    return this.entries.size;
  }

  idsOf(socket: string): number[] {
    return [...(this.owned.get(socket) ?? [])];
  }

  // Restores ownership after a wake. The states come back with the
  // next heartbeat.
  claim(owner: Owner, ids: number[]): void {
    for (const id of ids) this.own(owner, id);
  }

  private own(owner: Owner, id: number): void {
    this.owners.set(id, owner.socket);
    this.principalOf.set(owner.socket, owner.principal);
    const ids = this.owned.get(owner.socket) ?? new Set<number>();
    ids.add(id);
    this.owned.set(owner.socket, ids);
    const mine = this.principalIds.get(owner.principal) ?? new Set<number>();
    mine.add(id);
    this.principalIds.set(owner.principal, mine);
  }

  // Moves an id to a new socket of the same principal. The old state
  // goes, so the new socket's clock does not have to beat it.
  private transfer(owner: Owner, id: number, holder: string): void {
    this.owned.get(holder)?.delete(id);
    this.entries.delete(id);
    this.own(owner, id);
  }

  // Checks the whole frame before it changes anything. Throws
  // AwarenessViolation for a frame that breaks a rule of the socket or
  // its principal, and a plain error for a frame that does not decode.
  // A full document is not a violation: it leaves the entry out.
  apply(update: Uint8Array, owner: Owner, identity: Identity): Applied {
    const incoming = decodeAwarenessUpdate(update);
    const claims = new Set<number>();
    const takeovers = new Set<number>();
    for (const entry of incoming) {
      const holder = this.owners.get(entry.id);
      if (holder !== undefined && holder !== owner.socket) {
        if (this.principalOf.get(holder) !== owner.principal) {
          throw new AwarenessViolation("client id belongs to another principal");
        }
        takeovers.add(entry.id);
      }
      if (entry.state.length > MAX_STATE_CHARS) {
        throw new AwarenessViolation("presence state is too large");
      }
      if (entry.state === "null") continue;
      parseState(entry.state);
      if (holder === undefined) claims.add(entry.id);
    }
    if ((this.owned.get(owner.socket)?.size ?? 0) + claims.size + takeovers.size > MAX_IDS_PER_SOCKET) {
      throw new AwarenessViolation("too many client ids on one socket");
    }
    if ((this.principalIds.get(owner.principal)?.size ?? 0) + claims.size > MAX_IDS_PER_PRINCIPAL) {
      throw new AwarenessViolation("too many client ids for one principal");
    }

    const accepted: AwarenessEntry[] = [];
    const displaced = new Set<string>();
    let refused = 0;
    for (const entry of incoming) {
      const holder = this.owners.get(entry.id);
      if (holder !== undefined && holder !== owner.socket) {
        this.transfer(owner, entry.id, holder);
        displaced.add(holder);
      }
      const current = this.entries.get(entry.id);
      if (current !== undefined && current.clock > entry.clock) continue;
      if (entry.state === "null") {
        // An id nobody announced has no state to remove.
        if (this.owners.get(entry.id) !== owner.socket) continue;
        this.entries.delete(entry.id);
        accepted.push(entry);
        continue;
      }
      if (current === undefined && this.entries.size >= MAX_ENTRIES_PER_DOC) {
        refused += 1;
        continue;
      }
      const state = parseState(entry.state);
      state.kind = identity.kind;
      if (identity.name !== undefined) state.name = identity.name;
      const stamped = { id: entry.id, clock: entry.clock, state: JSON.stringify(state) };
      this.own(owner, entry.id);
      this.entries.set(entry.id, stamped);
      accepted.push(stamped);
    }
    return { accepted, refused, displaced: [...displaced] };
  }

  encode(): Uint8Array {
    return encodeAwarenessUpdate([...this.entries.values()]);
  }

  // Frees every id the socket held. Builds the update that tells peers
  // these clients are gone.
  release(socket: string): Uint8Array | null {
    const gone: AwarenessEntry[] = [];
    const principal = this.principalOf.get(socket);
    for (const id of this.owned.get(socket) ?? []) {
      this.owners.delete(id);
      this.principalIds.get(principal ?? "")?.delete(id);
      const current = this.entries.get(id);
      if (current === undefined) continue;
      this.entries.delete(id);
      gone.push({ id, clock: current.clock + 1, state: "null" });
    }
    this.owned.delete(socket);
    this.principalOf.delete(socket);
    if (principal !== undefined && this.principalIds.get(principal)?.size === 0) {
      this.principalIds.delete(principal);
    }
    return gone.length === 0 ? null : encodeAwarenessUpdate(gone);
  }
}
