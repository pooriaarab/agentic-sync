import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as auth from "y-protocols/auth";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";

// The y-websocket wire protocol. Any stock Yjs client speaks it.
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

function message(type: number, write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  return encoding.toUint8Array(encoder);
}

export const syncStep1Message = (doc: Y.Doc): Uint8Array =>
  message(MESSAGE_SYNC, (e) => sync.writeSyncStep1(e, doc));

export const updateMessage = (update: Uint8Array): Uint8Array =>
  message(MESSAGE_SYNC, (e) => sync.writeUpdate(e, update));

export const awarenessMessage = (update: Uint8Array): Uint8Array =>
  message(MESSAGE_AWARENESS, (e) => encoding.writeVarUint8Array(e, update));

export const permissionDeniedMessage = (reason: string): Uint8Array =>
  message(MESSAGE_AUTH, (e) => auth.writePermissionDenied(e, reason));

export interface Incoming {
  reply?: Uint8Array;
  denied?: Uint8Array;
  awareness?: Uint8Array;
  queryAwareness?: boolean;
}

function isEmptyUpdate(update: Uint8Array): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  return structs.length === 0 && ds.clients.size === 0;
}

// Reads one client message. A reader without write rights gets a
// permission-denied reply and the document stays untouched. Throws on a
// malformed message, so the caller can close the connection.
export function readMessage(
  doc: Y.Doc,
  data: Uint8Array,
  options: { canWrite: boolean; origin: unknown },
): Incoming {
  const decoder = decoding.createDecoder(data);
  switch (decoding.readVarUint(decoder)) {
    case MESSAGE_SYNC: {
      const kind = decoding.readVarUint(decoder);
      if (kind === sync.messageYjsSyncStep1) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        sync.readSyncStep1(decoder, encoder, doc);
        return { reply: encoding.toUint8Array(encoder) };
      }
      if (kind === sync.messageYjsSyncStep2 || kind === sync.messageYjsUpdate) {
        const update = decoding.readVarUint8Array(decoder);
        if (options.canWrite) {
          Y.applyUpdate(doc, update, options.origin);
        } else if (!isEmptyUpdate(update)) {
          return { denied: permissionDeniedMessage("read-only role") };
        }
        return {};
      }
      throw new Error(`unknown sync message ${kind}`);
    }
    case MESSAGE_AWARENESS:
      return { awareness: decoding.readVarUint8Array(decoder) };
    case MESSAGE_QUERY_AWARENESS:
      return { queryAwareness: true };
    default:
      throw new Error("unknown message type");
  }
}
