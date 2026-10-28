import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as auth from "y-protocols/auth";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import {
  decodeAwarenessUpdate,
  encodeAwarenessUpdate,
  type AwarenessEntry,
} from "../src/core/awareness.js";
import {
  awarenessMessage,
  MESSAGE_AUTH,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  syncStep1Message,
  updateMessage,
} from "../src/core/protocol.js";

// A bare protocol client, as a stock y-websocket client behaves.
export class Peer {
  readonly doc = new Y.Doc();
  readonly denied: string[] = [];
  readonly awareness: AwarenessEntry[] = [];
  readonly synced: Promise<void>;
  // The close code, once the server or this peer closes the socket.
  readonly closed: Promise<number>;
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = "arraybuffer";
    this.synced = new Promise((resolve, reject) => {
      this.socket.onerror = () => reject(new Error("connection refused"));
      this.socket.onclose = () => reject(new Error("connection closed"));
      this.socket.onopen = () => this.socket.send(syncStep1Message(this.doc));
      this.socket.onmessage = (event) => {
        const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
        const type = decoding.readVarUint(decoder);
        if (type === MESSAGE_SYNC) {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, MESSAGE_SYNC);
          const kind = sync.readSyncMessage(decoder, reply, this.doc, this);
          if (encoding.length(reply) > 1) this.socket.send(encoding.toUint8Array(reply));
          if (kind === sync.messageYjsSyncStep2) resolve();
        } else if (type === MESSAGE_AUTH) {
          auth.readAuthMessage(decoder, this.doc, (_doc, reason) => this.denied.push(reason));
        } else if (type === MESSAGE_AWARENESS) {
          this.awareness.push(...decodeAwarenessUpdate(decoding.readVarUint8Array(decoder)));
        }
      };
    });
    this.closed = new Promise((resolve) => {
      this.socket.addEventListener("close", (event) => resolve(event.code));
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this) this.socket.send(updateMessage(update));
    });
  }

  setPresence(id: number, clock: number, state: object): void {
    this.socket.send(
      awarenessMessage(encodeAwarenessUpdate([{ id, clock, state: JSON.stringify(state) }])),
    );
  }

  // Sends bytes as they are, with no encoding of their own.
  sendRaw(bytes: Uint8Array): void {
    this.socket.send(bytes);
  }

  sendPresence(entries: AwarenessEntry[]): void {
    this.socket.send(awarenessMessage(encodeAwarenessUpdate(entries)));
  }

  close(): void {
    this.socket.close(1000);
  }
}

export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
