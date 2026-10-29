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
export {
  DARK_BACKGROUND,
  GRAPHIC_CONTRAST,
  LIGHT_BACKGROUND,
  TEXT_CONTRAST,
  contrastRatio,
  isHexColor,
  peerColor,
  safePeerColor,
} from "./core/colors.js";
export type { ColorMode } from "./core/colors.js";
export {
  FALLBACK_NAME,
  MAX_NAME_LENGTH,
  assertSafePeerName,
  displayPeerName,
  isSafePeerName,
} from "./core/names.js";
export { restoreState } from "./core/history.js";
export { AttributionLog, blameText, DEFAULT_MAX_RANGES } from "./core/attribution.js";
export type { Attribution, AttributionRange, BlameSpan } from "./core/attribution.js";
