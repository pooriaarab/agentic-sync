import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import {
  AwarenessRelay,
  AwarenessViolation,
  encodeAwarenessUpdate,
  type Owner,
} from "../core/awareness.js";
import {
  awarenessMessage,
  permissionDeniedMessage,
  readMessage,
  syncStep1Message,
  updateMessage,
} from "../core/protocol.js";
import {
  assertGrant,
  canWrite,
  DOC_ID_PATTERN,
  effectiveRole,
  isMachineKind,
  MAX_CAPS,
  MAX_REVOKED,
  MAX_PRINCIPAL_ID_LENGTH,
  MAX_SNAPSHOTS,
  ROLES,
  type Cap,
  type DocMeta,
  type Grant,
  type Principal,
  type Role,
  type SnapshotInfo,
} from "../core/types.js";

export const GRANT_HEADER = "x-agentic-sync-grant";
export const DOC_HEADER = "x-agentic-sync-doc";

// Asks the host who the principal is now. Returns the principal's current
// role, or null when it has no access. A throw or an unknown role counts
// as no access, so a host outage cannot keep a revoked principal in.
export type Reauthorize = (
  principal: Principal,
  docId: string,
  env: RoomEnv & Record<string, unknown>,
) => Role | null | Promise<Role | null>;

const MAX_MESSAGE_BYTES = 1024 * 1024;
// Storage values cap at 2 MiB. Staying under it keeps compaction possible.
const MAX_DOC_BYTES = 1536 * 1024;
const DEFAULT_COMPACT_EVERY = 50;
// Storage deletes up to 128 keys per call, so a batch never exceeds that.
const MAX_COMPACT_EVERY = 128;
const FROM_STORAGE = "storage";
// A new socket of the same principal took over this socket's client id.
const CLOSE_REPLACED = 4001;
// The host revoked this socket's principal.
const CLOSE_REVOKED = 4003;
const PRESENCE_FULL = "presence is full";
const DEFAULT_REAUTH_SECONDS = 60;
const MAX_REAUTH_SECONDS = 3600;
// A slow host must not hold up the principals behind it.
const HOST_TIMEOUT_MS = 5000;
const HOST_CALLS_AT_ONCE = 20;

function withTimeout<T>(work: T | Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the host did not answer in time")), ms);
    Promise.resolve(work).then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error)),
    );
  });
}

interface Attachment {
  grant: Grant;
  // Names this socket in the presence relay.
  socketId: string;
  awarenessIds: number[];
  // The newest role the host gave on a timer check. It only narrows the grant.
  reauthRole?: Role;
}

function ownerOf({ grant, socketId }: Attachment): Owner {
  return { socket: socketId, principal: `${grant.principal.kind}:${grant.principal.id}` };
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

interface SnapshotRecord {
  name: string;
  at: number;
  bytes: number;
  author: Principal;
}

export interface RoomEnv {
  SYNC_COMPACT_EVERY?: string;
  // Seconds between re-authorizations of open sockets. Default 60.
  SYNC_REAUTH_INTERVAL_SECONDS?: string;
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
  private readonly reauthMs: number;
  // Host caps by principal id. Values come from storage, so they are unknown.
  private readonly caps = new Map<string, unknown>();
  private docId?: string;
  private pending: string[] = [];
  private seq = 0;
  private compactions = 0;
  // Upper bound on the stored size of the document.
  private bytes = 0;

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    const configured = Number.parseInt(env.SYNC_COMPACT_EVERY ?? "", 10);
    this.compactEvery = Number.isInteger(configured)
      ? Math.min(MAX_COMPACT_EVERY, Math.max(1, configured))
      : DEFAULT_COMPACT_EVERY;
    const reauthSeconds = Number.parseInt(env.SYNC_REAUTH_INTERVAL_SECONDS ?? "", 10);
    this.reauthMs =
      (Number.isInteger(reauthSeconds)
        ? Math.min(MAX_REAUTH_SECONDS, Math.max(1, reauthSeconds))
        : DEFAULT_REAUTH_SECONDS) * 1000;
    this.doc.on("update", (update: Uint8Array, origin: unknown) =>
      this.onUpdate(update, origin),
    );
    for (const ws of ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment;
      this.relay.claim(ownerOf(attachment), attachment.awarenessIds);
    }
    ctx.blockConcurrencyWhile(() => this.load());
  }

  // A host overrides this to turn on re-authorization. See createSyncRoom.
  protected reauthorizer(): Reauthorize | undefined {
    return undefined;
  }

  private remember(author: Principal): void {
    this.authors.set(`${author.kind}:${author.id}`, author);
  }

  private async load(): Promise<void> {
    this.docId = await this.ctx.storage.get<string>("docid");
    const caps = await this.ctx.storage.list({ prefix: "cap:" });
    for (const [key, cap] of caps) this.caps.set(key.slice(4), cap);
    const base = await this.ctx.storage.get<BaseRecord>("base");
    if (base !== undefined) {
      Y.applyUpdate(this.doc, base.state, FROM_STORAGE);
      base.authors.forEach((author) => this.remember(author));
      this.compactions = base.compactions;
      this.bytes = base.state.length;
    }
    const log = await this.ctx.storage.list<UpdateRecord>({ prefix: "u:" });
    for (const [key, record] of log) {
      Y.applyUpdate(this.doc, record.update, FROM_STORAGE);
      this.remember(record.author);
      this.bytes += record.update.length;
      this.pending.push(key);
      this.seq = Number.parseInt(key.slice(2), 10);
    }
  }

  private onUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === FROM_STORAGE) return;
    const { ws, author } = origin as { ws: WebSocket; author: Principal };
    this.remember(author);
    this.bytes += update.length;
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
    const state = Y.encodeStateAsUpdate(this.doc);
    this.bytes = state.length;
    const base: BaseRecord = {
      state,
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
      if (peer !== except && peer.readyState === WebSocket.OPEN) peer.send(data);
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

  private withLabel(record: SnapshotRecord): SnapshotInfo {
    return { ...record, author: { ...record.author, machine: isMachineKind(record.author.kind) } };
  }

  private async snapshots(request: Request, name: string | undefined): Promise<Response> {
    const storage = this.ctx.storage;
    if (name !== undefined) {
      const state = await storage.get<Uint8Array>(`d:${name}`);
      return state ? new Response(new Uint8Array(state)) : new Response(null, { status: 404 });
    }
    if (request.method === "GET") {
      const all = await storage.list<SnapshotRecord>({ prefix: "s:" });
      return Response.json([...all.values()].map((record) => this.withLabel(record)));
    }
    const { name: wanted, author } = (await request.json()) as { name: string; author: Principal };
    // A cap may have landed since the Worker checked the role.
    const held = effectiveRole("owner", this.caps.get(author.id));
    if (held === null || !canWrite(held)) return new Response(null, { status: 403 });
    const taken = await storage.list({ prefix: "s:" });
    if (taken.has(`s:${wanted}`) || taken.size >= MAX_SNAPSHOTS) return new Response(null, { status: 409 });
    const state = Y.encodeStateAsUpdate(this.doc);
    const record: SnapshotRecord = { name: wanted, at: Date.now(), bytes: state.byteLength, author };
    await storage.put({ [`s:${wanted}`]: record, [`d:${wanted}`]: state });
    return Response.json(this.withLabel(record), { status: 201 });
  }

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/meta") return Response.json(this.meta());
    if (pathname.startsWith("/snapshots")) {
      return this.snapshots(request, pathname.split("/")[2]);
    }
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected a websocket", { status: 426 });
    }
    const header = request.headers.get(GRANT_HEADER);
    if (header === null) return new Response("missing grant", { status: 400 });
    const grant = assertGrant(JSON.parse(decodeURIComponent(header)));
    const role = this.capRole(grant);
    if (role === null) return new Response("access revoked", { status: 403 });
    grant.role = role;
    const docId = request.headers.get(DOC_HEADER);
    if (docId !== null && DOC_ID_PATTERN.test(docId) && docId !== this.docId) {
      this.docId = docId;
      await this.ctx.storage.put("docid", docId);
    }
    await this.scheduleReauth();
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      grant,
      socketId: crypto.randomUUID(),
      awarenessIds: [],
    } satisfies Attachment);
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
    const { principal } = attachment.grant;
    const role = this.capRole(attachment.grant, attachment.reauthRole);
    if (role === null) {
      this.evict(ws, CLOSE_REVOKED, "access revoked");
      return;
    }
    let incoming;
    try {
      incoming = readMessage(this.doc, new Uint8Array(data), {
        canWrite: canWrite(role),
        origin: { ws, author: principal },
        refuse: (update) =>
          this.bytes + update.length > MAX_DOC_BYTES ? "document size limit reached" : null,
      });
    } catch {
      ws.close(1007, "malformed message");
      return;
    }
    if (incoming.reply) ws.send(incoming.reply);
    if (incoming.denied) ws.send(incoming.denied);
    if (incoming.queryAwareness) ws.send(awarenessMessage(this.relay.encode()));
    if (incoming.awareness) {
      let applied;
      try {
        applied = this.relay.apply(incoming.awareness, ownerOf(attachment), {
          kind: principal.kind,
          name: attachment.grant.name,
        });
      } catch (error) {
        const violation = error instanceof AwarenessViolation;
        this.dropPresence(ws);
        ws.close(violation ? 1008 : 1007, violation ? error.message : "malformed message");
        return;
      }
      for (const socketId of applied.displaced) this.replace(socketId);
      if (applied.refused > 0) ws.send(permissionDeniedMessage(PRESENCE_FULL));
      if (applied.accepted.length > 0) {
        attachment.awarenessIds = this.relay.idsOf(attachment.socketId);
        ws.serializeAttachment(attachment);
        this.broadcast(awarenessMessage(encodeAwarenessUpdate(applied.accepted)), ws);
      }
    }
  }

  // Closes a socket that lost a client id to a new socket of the same
  // principal. Its other ids go with it. The server does not wait for
  // the close handshake, because a half-open socket never answers.
  private replace(socketId: string): void {
    const old = this.ctx.getWebSockets().find(
      (peer) => (peer.deserializeAttachment() as Attachment).socketId === socketId,
    );
    if (old !== undefined) this.evict(old, CLOSE_REPLACED, "client id taken over by a new connection");
  }

  // Drops the socket's presence and closes it.
  private evict(ws: WebSocket, code: number, reason: string): void {
    this.dropPresence(ws);
    // A wake must not hand this socket's ids back to it.
    ws.serializeAttachment({ ...(ws.deserializeAttachment() as Attachment), awarenessIds: [] });
    try {
      ws.close(code, reason);
    } catch {
      // The socket is already closed.
    }
  }

  // The role after the host's cap, or null when the principal is revoked.
  private capRole({ principal, role }: Grant, reauthRole?: Role): Role | null {
    const held = reauthRole === undefined ? role : effectiveRole(role, reauthRole);
    return held === null ? null : effectiveRole(held, this.caps.get(principal.id));
  }

  private async setCap(principalId: string, cap: Cap | null): Promise<boolean> {
    if (
      typeof principalId !== "string" ||
      principalId.length === 0 ||
      principalId.length > MAX_PRINCIPAL_ID_LENGTH
    ) {
      throw new TypeError("invalid principal id");
    }
    // A cap of owner never narrows anything, so it is the same as no cap.
    if (cap === null || cap === "owner") {
      this.caps.delete(principalId);
      await this.ctx.storage.delete(`cap:${principalId}`);
      return true;
    }
    // Role caps and bans have their own limits, so a full table of role
    // caps never stops a revoke.
    const ban = cap === "revoked";
    const held = [...this.caps.values()].filter((value) => (value === "revoked") === ban).length;
    // A change from one type to the other takes a slot of the new type.
    const sameType = this.caps.has(principalId) && (this.caps.get(principalId) === "revoked") === ban;
    if (!sameType && held >= (ban ? MAX_REVOKED : MAX_CAPS)) return false;
    this.caps.set(principalId, cap);
    await this.ctx.storage.put(`cap:${principalId}`, cap);
    return true;
  }

  // Closes every socket of the principal and refuses it from now on. Lift
  // the ban with updateRole(id, null). The sockets close even when the
  // document holds the most bans. Then `stored` is false and a new
  // connection is not refused.
  async revoke(principalId: string): Promise<{ closed: number; stored: boolean }> {
    const stored = await this.setCap(principalId, "revoked");
    let closed = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment).grant.principal.id !== principalId) continue;
      this.evict(ws, CLOSE_REVOKED, "access revoked");
      closed += 1;
    }
    return { closed, stored };
  }

  // Caps the role of a principal. It applies to the next message on every
  // open socket, so a downgraded editor is read-only at once. A null role
  // lifts the cap. Returns false when the document holds the most caps.
  async updateRole(principalId: string, role: Role | null): Promise<boolean> {
    if (role !== null && !ROLES.includes(role)) throw new TypeError("invalid role");
    return this.setCap(principalId, role);
  }

  // The role of the grant after the cap, or null when it is revoked.
  roleFor(grant: Grant): Role | null {
    return this.capRole(grant);
  }

  private async scheduleReauth(): Promise<void> {
    if (this.reauthorizer() === undefined) return;
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + this.reauthMs);
  }

  // Asks the host again who each connected principal is.
  async alarm(): Promise<void> {
    const reauthorize = this.reauthorizer();
    if (reauthorize === undefined || this.docId === undefined) return;
    const byPrincipal = new Map<string, WebSocket[]>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const { principal } = (ws.deserializeAttachment() as Attachment).grant;
      const key = `${principal.kind}:${principal.id}`;
      byPrincipal.set(key, [...(byPrincipal.get(key) ?? []), ws]);
    }
    const env = this.env as RoomEnv & Record<string, unknown>;
    const ask = async (principal: Principal): Promise<Role | null> => {
      try {
        const role = await withTimeout(reauthorize(principal, this.docId!, env), HOST_TIMEOUT_MS);
        return role !== null && ROLES.includes(role) ? role : null;
      } catch {
        return null;
      }
    };
    const groups = [...byPrincipal.values()];
    for (let i = 0; i < groups.length; i += HOST_CALLS_AT_ONCE) {
      await Promise.all(
        groups.slice(i, i + HOST_CALLS_AT_ONCE).map(async (sockets) => {
          const role = await ask((sockets[0].deserializeAttachment() as Attachment).grant.principal);
          for (const ws of sockets) {
            // A host call may have closed this socket while we waited.
            if (ws.readyState !== WebSocket.OPEN) continue;
            if (role === null) {
              this.evict(ws, CLOSE_REVOKED, "access revoked");
              continue;
            }
            const attachment = ws.deserializeAttachment() as Attachment;
            attachment.reauthRole = role;
            ws.serializeAttachment(attachment);
          }
        }),
      );
    }
    if (this.ctx.getWebSockets().some((ws) => ws.readyState === WebSocket.OPEN)) {
      await this.ctx.storage.setAlarm(Date.now() + this.reauthMs);
    }
  }

  // Tells peers that this socket's clients are gone. Safe to call twice.
  private dropPresence(ws: WebSocket): void {
    const { socketId } = ws.deserializeAttachment() as Attachment;
    const gone = this.relay.release(socketId);
    if (gone) this.broadcast(awarenessMessage(gone), ws);
  }

  webSocketClose(ws: WebSocket, code: number): void {
    this.dropPresence(ws);
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

// A room class that re-authorizes open sockets on a timer. Export it as
// SyncRoom from the host Worker, in place of the plain class.
export function createSyncRoom(options: { reauthorize: Reauthorize }): typeof SyncRoom {
  return class extends SyncRoom {
    protected override reauthorizer(): Reauthorize {
      return options.reauthorize;
    }
  };
}
