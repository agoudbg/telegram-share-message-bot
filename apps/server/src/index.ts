// @tbfb/server — HTTP server package: storage layer (Phase 2), Hono share
// data API and media streaming (Phase 3). See docs/PLAN.md.

export { createServerApp } from './api/app.js';
export type { ServerAppDeps, ShareMediaEntry, ShareResponse } from './api/app.js';
export { checkShareAccess } from './api/gate.js';
export { registerMediaRoutes } from './api/media.js';
export type { MediaRouteDeps } from './api/media.js';
export { createShareSanitizer, resolveMediaKey, sanitizeMediaKey } from './api/sanitize.js';
export { loadServerConfig } from './config.js';
export type { ServerConfig } from './config.js';
export { openDatabase } from './storage/database.js';
export type { StorageDatabase } from './storage/database.js';
export { MIGRATIONS } from './storage/schema.js';
export {
  createShare,
  deleteShare,
  deleteStalePendingShares,
  finalizeShare,
  getMedia,
  getMessage,
  getShare,
  insertMediaIfAbsent,
  insertMessage,
  linkMediaToShare,
  listMessages,
  listPeers,
  listShareMedia,
  revokeShare,
  rewriteMessageSeqs,
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
