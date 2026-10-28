import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { PrincipalKind } from "./types.js";

export interface AwarenessEntry {
  id: number;
  clock: number;
  state: string;
}

export const MAX_STATE_CHARS = 8192;
export const MAX_IDS_PER_SOCKET = 32;
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
// can update or remove it. Each socket owns a few ids and the document
// holds a few entries, so a client cannot grow the relay without bound.
export class AwarenessRelay {
  private readonly entries = new Map<number, AwarenessEntry>();
  private readonly owners = new Map<number, string>();
  private readonly owned = new Map<string, Set<number>>();

  get size(): number {
    return this.entries.size;
  }

  idsOf(owner: string): number[] {
    return [...(this.owned.get(owner) ?? [])];
  }

  // Restores ownership after a wake. The states come back with the
  // next heartbeat.
  claim(owner: string, ids: number[]): void {
    for (const id of ids) this.own(owner, id);
  }

  private own(owner: string, id: number): void {
    this.owners.set(id, owner);
    const ids = this.owned.get(owner) ?? new Set<number>();
    ids.add(id);
    this.owned.set(owner, ids);
  }

  // Checks the whole frame before it changes anything, then returns
  // the entries it accepted, with the identity stamped in. The caller
  // relays those entries and nothing else. Throws AwarenessViolation
  // for a frame that breaks a rule, and a plain error for a frame that
  // does not decode.
  apply(update: Uint8Array, owner: string, identity: Identity): AwarenessEntry[] {
    const incoming = decodeAwarenessUpdate(update);
    const claims = new Set<number>();
    const additions = new Set<number>();
    for (const entry of incoming) {
      const holder = this.owners.get(entry.id);
      if (holder !== undefined && holder !== owner) {
        throw new AwarenessViolation("client id belongs to another socket");
      }
      if (entry.state.length > MAX_STATE_CHARS) {
        throw new AwarenessViolation("presence state is too large");
      }
      if (entry.state === "null") continue;
      parseState(entry.state);
      if (holder === undefined) claims.add(entry.id);
      if (!this.entries.has(entry.id)) additions.add(entry.id);
    }
    if ((this.owned.get(owner)?.size ?? 0) + claims.size > MAX_IDS_PER_SOCKET) {
      throw new AwarenessViolation("too many client ids on one socket");
    }
    if (this.entries.size + additions.size > MAX_ENTRIES_PER_DOC) {
      throw new AwarenessViolation("too many presence entries on this document");
    }

    const accepted: AwarenessEntry[] = [];
    for (const entry of incoming) {
      const current = this.entries.get(entry.id);
      if (current !== undefined && current.clock > entry.clock) continue;
      if (entry.state === "null") {
        // An id nobody announced has no state to remove.
        if (this.owners.get(entry.id) !== owner) continue;
        this.entries.delete(entry.id);
        accepted.push(entry);
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
    return accepted;
  }

  encode(): Uint8Array {
    return encodeAwarenessUpdate([...this.entries.values()]);
  }

  // Frees every id the owner held. Builds the update that tells peers
  // these clients are gone.
  release(owner: string): Uint8Array | null {
    const gone: AwarenessEntry[] = [];
    for (const id of this.owned.get(owner) ?? []) {
      this.owners.delete(id);
      const current = this.entries.get(id);
      if (current === undefined) continue;
      this.entries.delete(id);
      gone.push({ id, clock: current.clock + 1, state: "null" });
    }
    this.owned.delete(owner);
    return gone.length === 0 ? null : encodeAwarenessUpdate(gone);
  }
}
