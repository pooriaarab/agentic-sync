import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { AwarenessRelay } from "../core/awareness.js";
import {
  awarenessMessage,
  readMessage,
  syncStep1Message,
  updateMessage,
} from "../core/protocol.js";
import {
  assertGrant,
  canWrite,
  isMachineKind,
  type DocMeta,
  type Grant,
  type Principal,
} from "../core/types.js";

export const GRANT_HEADER = "x-agentic-sync-grant";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_AWARENESS_IDS = 32;
const DEFAULT_COMPACT_EVERY = 50;
// Storage deletes up to 128 keys per call, so a batch never exceeds that.
const MAX_COMPACT_EVERY = 128;
const FROM_STORAGE = "storage";

interface Attachment {
  grant: Grant;
  awarenessIds: number[];
}

// One stored Yjs update and who made it.
interface UpdateRecord {
  update: Uint8Array;
  author: Principal;
  at: number;
}

// The compacted state of all earlier updates, and everyone who wrote them.
interface BaseRecord {
  state: Uint8Array;
  authors: Principal[];
  compactions: number;
  at: number;
}

export interface RoomEnv {
  SYNC_COMPACT_EVERY?: string;
}

// One Durable Object holds one document. It keeps the Y.Doc in memory
// while connections are open and rebuilds it from storage after a
// hibernation. Updates append to a log. Every N updates the log folds
// into one base snapshot.
export class SyncRoom extends DurableObject<RoomEnv> {
  private readonly doc = new Y.Doc();
  private readonly relay = new AwarenessRelay();
  private readonly authors = new Map<string, Principal>();
  private readonly compactEvery: number;
  private pending: string[] = [];
  private seq = 0;
  private compactions = 0;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    const configured = Number.parseInt(env.SYNC_COMPACT_EVERY ?? "", 10);
    this.compactEvery = Number.isInteger(configured)
      ? Math.min(MAX_COMPACT_EVERY, Math.max(1, configured))
      : DEFAULT_COMPACT_EVERY;
    this.doc.on("update", (update: Uint8Array, origin: unknown) =>
      this.onUpdate(update, origin),
    );
    ctx.blockConcurrencyWhile(() => this.load());
  }

  private remember(author: Principal): void {
    this.authors.set(`${author.kind}:${author.id}`, author);
  }

  private async load(): Promise<void> {
    const base = await this.ctx.storage.get<BaseRecord>("base");
    if (base !== undefined) {
      Y.applyUpdate(this.doc, base.state, FROM_STORAGE);
      base.authors.forEach((author) => this.remember(author));
      this.compactions = base.compactions;
    }
    const log = await this.ctx.storage.list<UpdateRecord>({ prefix: "u:" });
    for (const [key, record] of log) {
      Y.applyUpdate(this.doc, record.update, FROM_STORAGE);
      this.remember(record.author);
      this.pending.push(key);
      this.seq = Number.parseInt(key.slice(2), 10);
    }
  }

  private onUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === FROM_STORAGE) return;
    const { ws, author } = origin as { ws: WebSocket; author: Principal };
    this.remember(author);
    const key = `u:${String(++this.seq).padStart(10, "0")}`;
    const record: UpdateRecord = { update, author, at: Date.now() };
    void this.ctx.storage.put(key, record);
    this.pending.push(key);
    this.broadcast(updateMessage(update), ws);
    if (this.pending.length >= this.compactEvery) this.compact();
  }

  // Both writes run in one tick, so storage applies them together.
  private compact(): void {
    this.compactions += 1;
    const base: BaseRecord = {
      state: Y.encodeStateAsUpdate(this.doc),
      authors: [...this.authors.values()],
      compactions: this.compactions,
      at: Date.now(),
    };
    void this.ctx.storage.put("base", base);
    void this.ctx.storage.delete(this.pending);
    this.pending = [];
  }

  private broadcast(data: Uint8Array, except?: WebSocket): void {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== except) peer.send(data);
    }
  }

  private meta(): DocMeta {
    return {
      updates: this.pending.length,
      compactions: this.compactions,
      contributors: [...this.authors.values()].map((author) => ({
        ...author,
        machine: isMachineKind(author.kind),
      })),
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/meta") return Response.json(this.meta());
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket", { status: 426 });
    }
    const header = request.headers.get(GRANT_HEADER);
    if (header === null) return new Response("missing grant", { status: 400 });
    const grant = assertGrant(JSON.parse(decodeURIComponent(header)));
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ grant, awarenessIds: [] } satisfies Attachment);
    server.send(syncStep1Message(this.doc));
    if (this.relay.size > 0) server.send(awarenessMessage(this.relay.encode()));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): void {
    if (typeof data === "string" || data.byteLength > MAX_MESSAGE_BYTES) {
      ws.close(1009, "binary messages up to 1 MiB only");
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment;
    const { principal, role } = attachment.grant;
    let incoming;
    try {
      incoming = readMessage(this.doc, new Uint8Array(data), {
        canWrite: canWrite(role),
        origin: { ws, author: principal },
      });
    } catch {
      ws.close(1007, "malformed message");
      return;
    }
    if (incoming.reply) ws.send(incoming.reply);
    if (incoming.denied) ws.send(incoming.denied);
    if (incoming.queryAwareness) ws.send(awarenessMessage(this.relay.encode()));
    if (incoming.awareness) {
      const accepted = this.relay.apply(incoming.awareness);
      const ids = new Set(attachment.awarenessIds);
      accepted.forEach((entry) => ids.add(entry.id));
      attachment.awarenessIds = [...ids].slice(0, MAX_AWARENESS_IDS);
      ws.serializeAttachment(attachment);
      this.broadcast(awarenessMessage(incoming.awareness), ws);
    }
  }

  webSocketClose(ws: WebSocket, code: number): void {
    const { awarenessIds } = ws.deserializeAttachment() as Attachment;
    const gone = this.relay.remove(awarenessIds);
    if (gone) this.broadcast(awarenessMessage(gone), ws);
    try {
      // 1005 and 1006 are reserved and cannot be sent back.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // The socket is already closed.
    }
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws, 1011);
  }
}
