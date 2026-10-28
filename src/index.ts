export { VERSION } from "./version.js";
export {
  PRINCIPAL_KINDS,
  ROLES,
  DOC_ID_PATTERN,
  SNAPSHOT_NAME_PATTERN,
  MAX_SNAPSHOTS,
  canWrite,
  isMachineKind,
  assertGrant,
} from "./core/types.js";
export type {
  PrincipalKind,
  Role,
  Principal,
  Grant,
  Authorize,
  Contributor,
  DocMeta,
  SnapshotInfo,
  Realtime,
} from "./core/types.js";
export {
  MESSAGE_SYNC,
  MESSAGE_AWARENESS,
  MESSAGE_AUTH,
  MESSAGE_QUERY_AWARENESS,
  syncStep1Message,
  updateMessage,
  awarenessMessage,
  permissionDeniedMessage,
  readMessage,
} from "./core/protocol.js";
export type { Incoming } from "./core/protocol.js";
export {
  AwarenessRelay,
  decodeAwarenessUpdate,
  encodeAwarenessUpdate,
} from "./core/awareness.js";
export type { AwarenessEntry } from "./core/awareness.js";
export { restoreState } from "./core/history.js";
