import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

export interface AwarenessEntry {
  id: number;
  clock: number;
  state: string;
}

const MAX_STATE_CHARS = 8192;

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

// Server side presence. It holds the latest state per client and does
// not run timers, so a hibernating Durable Object can sleep. Clients
// resend their state on a heartbeat, which refills it after a wake.
export class AwarenessRelay {
  private readonly entries = new Map<number, AwarenessEntry>();

  get size(): number {
    return this.entries.size;
  }

  // Returns the entries it accepted, for the caller to relay.
  apply(update: Uint8Array): AwarenessEntry[] {
    const accepted: AwarenessEntry[] = [];
    for (const entry of decodeAwarenessUpdate(update)) {
      if (entry.state.length > MAX_STATE_CHARS) continue;
      if (entry.state !== "null") {
        try {
          JSON.parse(entry.state);
        } catch {
          continue;
        }
      }
      const current = this.entries.get(entry.id);
      if (current !== undefined && current.clock > entry.clock) continue;
      if (entry.state === "null") this.entries.delete(entry.id);
      else this.entries.set(entry.id, entry);
      accepted.push(entry);
    }
    return accepted;
  }

  encode(): Uint8Array {
    return encodeAwarenessUpdate([...this.entries.values()]);
  }

  // Builds the update that tells peers these clients are gone.
  remove(ids: number[]): Uint8Array | null {
    const gone: AwarenessEntry[] = [];
    for (const id of ids) {
      const current = this.entries.get(id);
      if (current === undefined) continue;
      this.entries.delete(id);
      gone.push({ id, clock: current.clock + 1, state: "null" });
    }
    return gone.length === 0 ? null : encodeAwarenessUpdate(gone);
  }
}
