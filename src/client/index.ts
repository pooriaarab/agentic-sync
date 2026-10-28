import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as auth from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import {
  awarenessMessage,
  MESSAGE_AUTH,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  syncStep1Message,
  updateMessage,
} from "../core/protocol.js";
import type { PrincipalKind } from "../core/types.js";

// What a client shows to the others. Do not put personal data here.
// The client sets no kind. The server adds it from the grant.
export interface Presence {
  name: string;
  color: string;
  cursor: unknown;
}

// Another peer. The server stamps `kind` from that peer's grant, so a
// client cannot change it. An agent always shows as an agent.
export interface Peer extends Presence {
  clientId: number;
  kind: PrincipalKind;
}

type SocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket;

export interface ConnectOptions {
  // The ws:// or wss:// address of /api/v1/docs/:id/ws.
  url: string;
  // Sent with the upgrade request. Put an Authorization header here.
  headers?: Record<string, string>;
  doc?: Y.Doc;
  presence?: Pick<Presence, "name"> & Partial<Presence>;
  timeoutMs?: number;
  WebSocket?: SocketConstructor;
}

interface Barrier {
  resolve(): void;
  reject(error: Error): void;
}

function colorFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return `hsl(${hash} 70% 45%)`;
}

// A headless client for one document. It holds a Y.Doc that stays in step
// with the server.
export class SyncClient {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  // Reasons the server gave when it dropped an update, in order.
  readonly denied: string[] = [];
  private readonly socket: WebSocket;
  private readonly barriers: Barrier[] = [];
  private readonly timeoutMs: number;
  private readonly closed: Promise<void>;
  private readonly opened: Promise<void>;

  private constructor(options: ConnectOptions) {
    this.doc = options.doc ?? new Y.Doc();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    const Socket = options.WebSocket ?? (WebSocket as unknown as SocketConstructor);
    this.socket = new Socket(options.url, { headers: options.headers });
    this.socket.binaryType = "arraybuffer";
    this.opened = new Promise((resolve, reject) => {
      this.socket.onopen = () => {
        if (this.awareness.getLocalState() !== null) this.sendPresence([this.doc.clientID]);
        resolve();
      };
      this.socket.onerror = () => reject(new Error("could not connect"));
    });
    this.closed = new Promise((resolve) => {
      this.socket.onclose = () => {
        this.barriers.splice(0).forEach((b) => b.reject(new Error("connection closed")));
        resolve();
      };
    });
    this.socket.onmessage = (event) => this.receive(new Uint8Array(event.data as ArrayBuffer));
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this) this.send(updateMessage(update));
    });
    this.awareness.on(
      "update",
      ({ added, updated, removed }: Record<"added" | "updated" | "removed", number[]>, origin: unknown) => {
        if (origin === this) return;
        this.sendPresence([...added, ...updated, ...removed]);
      },
    );
    if (options.presence) {
      const { name, color = colorFor(name), cursor = null } = options.presence;
      this.awareness.setLocalState({ name, color, cursor } satisfies Presence);
    }
  }

  // Connects and resolves once the document matches the server.
  static async connect(options: ConnectOptions): Promise<SyncClient> {
    const client = new SyncClient(options);
    await client.opened;
    await client.flush();
    return client;
  }

  private sendPresence(ids: number[]): void {
    this.send(awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids)));
  }

  private send(data: Uint8Array): void {
    if (this.socket.readyState === 1) this.socket.send(data);
  }

  private receive(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    switch (decoding.readVarUint(decoder)) {
      case MESSAGE_SYNC: {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        const kind = sync.readSyncMessage(decoder, reply, this.doc, this);
        if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply));
        if (kind === sync.messageYjsSyncStep2) this.barriers.shift()?.resolve();
        break;
      }
      case MESSAGE_AUTH:
        auth.readAuthMessage(decoder, this.doc, (_doc, reason) => this.denied.push(reason));
        break;
      case MESSAGE_AWARENESS:
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          this,
        );
        break;
    }
  }

  // Resolves when the server has handled every change made so far. The
  // server answers in order, so its reply to a new sync request proves it.
  flush(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no answer from the server in ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
      this.barriers.push({
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.send(syncStep1Message(this.doc));
    });
  }

  // Runs one change, then waits until the server has it.
  async edit(change: (doc: Y.Doc) => void): Promise<void> {
    this.doc.transact(() => change(this.doc));
    await this.flush();
  }

  // The other peers, as they show themselves.
  get peers(): Peer[] {
    return [...this.awareness.getStates()]
      .filter(([clientId]) => clientId !== this.doc.clientID)
      .map(([clientId, state]) => ({ clientId, ...(state as Omit<Peer, "clientId">) }));
  }

  setPresence(patch: Partial<Presence>): void {
    this.awareness.setLocalState({ ...this.awareness.getLocalState(), ...patch });
  }

  async disconnect(): Promise<void> {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "disconnect");
    this.awareness.destroy();
    this.socket.close(1000);
    await this.closed;
  }
}
