import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as auth from "y-protocols/auth";
import * as awarenessProtocol from "y-protocols/awareness";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import * as sdk from "../sdk.js";
import {
  awarenessMessage,
  MESSAGE_AUTH,
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  syncStep1Message,
  updateMessage,
} from "../core/protocol.js";
import { restoreState } from "../core/history.js";
import { AwayTracker, readAwayState, type AwayState } from "../core/away.js";
import { peerColor, safePeerColor } from "../core/colors.js";
import { assertSafePeerName, displayPeerName } from "../core/names.js";
import { isMachineKind, type PrincipalKind, type Role, type SnapshotInfo } from "../core/types.js";

// What a client shows to the others. Do not put personal data here.
// The client sets no kind. The server adds it from the grant.
export interface Presence {
  name: string;
  color: string;
  cursor: unknown;
  // Set when the client has an away tracker. See AwayState.
  away?: AwayState;
}

// Another peer. The server stamps `kind` from that peer's grant, so a
// client cannot change it. An agent always shows as an agent.
export interface Peer extends Omit<Presence, "away"> {
  clientId: number;
  // "unknown" for a peer that does not report it.
  away: AwayState | "unknown";
  kind: PrincipalKind;
  // True for every kind except a person. Show it in the UI.
  machine: boolean;
}

export type Status = "connecting" | "connected" | "disconnected";

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
  // Report idle and hidden to the peers. Feed it with `markActive` and
  // `setHidden`, or use `watchPageAway` in a browser. Needs `presence`.
  away?: { idleAfterSeconds: number };
  timeoutMs?: number;
  // Reconnect after a drop, with delays that double up to maxMs.
  reconnect?: { initialMs?: number; maxMs?: number };
  onStatus?: (status: Status) => void;
  WebSocket?: SocketConstructor;
}

interface Barrier {
  resolve(): void;
  reject(error: Error): void;
}

// A headless client for one document. It holds a Y.Doc that stays in step
// with the server.
export class SyncClient {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  // Reasons the server gave when it dropped an update, in order.
  readonly denied: string[] = [];
  private socket!: WebSocket;
  private readonly options: ConnectOptions;
  private readonly barriers: Barrier[] = [];
  private readonly waiting: Barrier[] = [];
  private readonly timeoutMs: number;
  private synced = false;
  private stopped = false;
  private delayMs: number;
  private retry?: ReturnType<typeof setTimeout>;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>((resolve) => (this.resolveClosed = resolve));
  private opened!: Promise<void>;
  private awayTracker?: AwayTracker;

  private constructor(options: ConnectOptions) {
    // Check the options first, so a bad one leaves nothing behind.
    const name = options.presence && assertSafePeerName(options.presence.name);
    if (options.away && !options.presence) throw new Error("the away option needs presence");
    if (options.away) {
      this.awayTracker = new AwayTracker({
        idleAfterSeconds: options.away.idleAfterSeconds,
        onChange: (away) => this.setPresence({ away }),
      });
    }
    this.options = options;
    this.doc = options.doc ?? new Y.Doc();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.delayMs = options.reconnect?.initialMs ?? 500;
    this.awareness = new awarenessProtocol.Awareness(this.doc);
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
      const { color = peerColor(name!), cursor = null } = options.presence;
      this.awareness.setLocalState({ name: name!, color, cursor } satisfies Presence);
    }
    if (this.awayTracker) this.setPresence({ away: this.awayTracker.state });
    this.open();
  }

  private open(): void {
    const Socket = this.options.WebSocket ?? (WebSocket as unknown as SocketConstructor);
    // A browser reads the second argument as a protocol list, so pass it
    // only when there are headers.
    const socket = this.options.headers
      ? new Socket(this.options.url, { headers: this.options.headers })
      : new Socket(this.options.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.options.onStatus?.("connecting");
    this.opened = new Promise((resolve, reject) => {
      socket.onopen = () => {
        this.delayMs = this.options.reconnect?.initialMs ?? 500;
        this.options.onStatus?.("connected");
        if (this.awareness.getLocalState() !== null) this.sendPresence([this.doc.clientID]);
        this.flush().then(
          () => {
            this.synced = true;
            this.waiting.splice(0).forEach((w) => w.resolve());
          },
          // Only an open socket that stays silent is reported here.
          (error: Error) => {
            if (socket.readyState === 1) this.waiting.splice(0).forEach((w) => w.reject(error));
          },
        );
        resolve();
      };
      socket.onerror = () => {
        reject(new Error("could not connect"));
        drop();
      };
    });
    this.opened.catch(() => undefined);
    socket.onmessage = (event) => this.receive(new Uint8Array(event.data as ArrayBuffer));
    // A refused connection may raise an error and no close, so both end it.
    let ended = false;
    const drop = () => {
      if (ended) return;
      ended = true;
      socket.close();
      this.synced = false;
      this.barriers.splice(0).forEach((b) => b.reject(new Error("connection closed")));
      this.options.onStatus?.("disconnected");
      if (this.stopped || !this.options.reconnect) {
        this.waiting.splice(0).forEach((w) => w.reject(new Error("connection closed")));
        this.resolveClosed();
        return;
      }
      this.retry = setTimeout(() => this.open(), this.delayMs);
      this.delayMs = Math.min(this.delayMs * 2, this.options.reconnect.maxMs ?? 30_000);
    };
    socket.onclose = drop;
  }

  // Returns at once and keeps trying while offline. Use whenSynced to wait.
  static open(options: ConnectOptions): SyncClient {
    return new SyncClient(options);
  }

  // Connects and resolves once the document matches the server.
  static async connect(options: ConnectOptions): Promise<SyncClient> {
    const client = new SyncClient(options);
    try {
      await client.opened;
      await client.whenSynced();
    } catch (error) {
      void client.disconnect();
      throw error;
    }
    return client;
  }

  whenSynced(): Promise<void> {
    if (this.synced) return Promise.resolve();
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  private sendPresence(ids: number[]): void {
    this.send(awarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids)));
  }

  private send(data: Uint8Array): void {
    if (this.socket?.readyState === 1) this.socket.send(data);
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
      .map(([clientId, state]) => {
        const peer = state as Omit<Peer, "clientId" | "machine">;
        const name = displayPeerName(peer.name);
        return { clientId, ...peer, name, color: safePeerColor(peer.color, name), away: readAwayState(peer.away), machine: isMachineKind(peer.kind) };
      });
  }

  // Your own away state, or undefined if you passed no `away` option.
  get away(): AwayState | undefined {
    return this.awayTracker?.state;
  }

  // Tells the tracker that you did something. It does nothing without `away`.
  markActive(): void {
    this.awayTracker?.activity();
  }

  // Tells the tracker that your page is hidden or visible again.
  setHidden(hidden: boolean): void {
    this.awayTracker?.setHidden(hidden);
  }

  // Calls you when anyone joins, leaves, or changes presence. Returns a
  // function that stops the calls.
  onPeers(listener: (peers: Peer[]) => void): () => void {
    const notify = () => listener(this.peers);
    this.awareness.on("change", notify);
    return () => this.awareness.off("change", notify);
  }

  setPresence(patch: Partial<Presence>): void {
    if (patch.name !== undefined) patch = { ...patch, name: assertSafePeerName(patch.name) };
    this.awareness.setLocalState({ ...this.awareness.getLocalState(), ...patch });
  }

  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(this.options.url);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = url.pathname.replace(/\/ws$/, "") + path;
    const headers = { ...this.options.headers, ...(init.body ? { "content-type": "application/json" } : {}) };
    const response = await fetch(url, { ...init, headers });
    if (!response.ok) throw new Error(`request failed: ${response.status}`);
    return response;
  }

  // Derive the HTTP target from the document socket, including a host path
  // prefix and query credentials. Header credentials take precedence.
  private httpTarget(host = false): { target: sdk.Target; docId: string } {
    const url = new URL(this.options.url);
    const match = /^(.*)\/api\/v1\/docs\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match) throw new Error("expected a document WebSocket URL");
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = match[1] || "/";
    // Host routes use only the explicit secret, never socket query credentials.
    if (host) url.search = "";
    return { target: { server: url.toString(), headers: this.options.headers }, docId: decodeURIComponent(match[2]) };
  }

  // Export stored history. Owners only. Local edits must be flushed first.
  exportDocument(): Promise<sdk.ExportRecord[]> {
    const { target, docId } = this.httpTarget();
    return sdk.exportDocument(target, docId);
  }

  // Erase stored history and close all sockets. Owners only; cannot be undone.
  deleteDocument(): Promise<{ deleted: true; sockets: number }> {
    const { target, docId } = this.httpTarget();
    return sdk.deleteDocument(target, docId);
  }

  // Host backend only. Pass the secret for this call; never give it to agents.
  revokePrincipal(secret: string, principalId: string): Promise<{ closed: number }> {
    const { target, docId } = this.httpTarget(true);
    return sdk.revokePrincipal({ server: target.server, secret }, docId, principalId);
  }

  // A null role lifts a cap or revoke. Keep the host secret in your backend.
  setPrincipalRole(secret: string, principalId: string, role: Role | null) {
    const { target, docId } = this.httpTarget(true);
    return sdk.setPrincipalRole({ server: target.server, secret }, docId, principalId, role);
  }

  // Saves the document as it is now, with your local edits, under a name.
  async snapshot(name: string): Promise<SnapshotInfo> {
    await this.flush();
    const body = JSON.stringify({ name });
    return (await (await this.api("/snapshots", { method: "POST", body })).json()) as SnapshotInfo;
  }

  async snapshots(): Promise<SnapshotInfo[]> {
    return (await (await this.api("/snapshots")).json()) as SnapshotInfo[];
  }

  // Sets the document back to a named snapshot. This is a new edit by you, so
  // later versions and all snapshots stay. Restore the later one to undo it.
  async restore(name: string): Promise<void> {
    const response = await this.api(`/snapshots/${encodeURIComponent(name)}`);
    restoreState(this.doc, new Uint8Array(await response.arrayBuffer()));
    await this.flush();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    this.awayTracker?.stop();
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "disconnect");
    this.awareness.destroy();
    if (this.socket.readyState === 3) this.resolveClosed();
    else this.socket.close(1000);
    await this.closed;
  }
}
