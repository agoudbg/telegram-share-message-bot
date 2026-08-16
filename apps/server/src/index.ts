// @tbfb/server — HTTP server package. Phase 2 provides the storage layer;
// the Hono share API and media streaming arrive in Phase 3 (docs/PLAN.md).

export { openDatabase } from './storage/database.js';
export type { StorageDatabase } from './storage/database.js';
export { MIGRATIONS } from './storage/schema.js';
export {
  createShare,
  deleteShare,
  finalizeShare,
  getMedia,
  getMessage,
  getShare,
  insertMediaIfAbsent,
  insertMessage,
  listMessages,
  listPeers,
  revokeShare,
  upsertPeer,
} from './storage/repository.js';
export type {
  MediaRow,
  MessageRow,
  PeerKind,
  PeerRow,
  ShareRow,
  ShareStatus,
} from './storage/repository.js';
