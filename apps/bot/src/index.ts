// @tbfb/bot — teleproto batch-forwarding bot. The entry point is main.ts
// (`node dist/main.js`); this module exposes the testable core.

export { BotApp } from './app.js';
export type { BotAppDeps } from './app.js';
export { BOT_COMMANDS, registerBotCommands } from './commands.js';
export { BatchManager, createForwardTracker, sortAlbumItems } from './batching.js';
export type { Batch, BatchCallbacks, BatchItem } from './batching.js';
export { loadConfig } from './config.js';
export type { BotConfig } from './config.js';
export { createBotLogger } from './logging.js';
export { startMediaOrigin } from './mediaOrigin.js';
export type { MediaOriginOptions } from './mediaOrigin.js';
export { MediaPipeline, extractForwardPeer, extractMediaInfo, withRetry } from './media.js';
export type { MediaInfo, MediaProcessResult, RetryOptions } from './media.js';
export type {
  BotPorts,
  InputDocumentRef,
  NormalizedMessage,
  ResolvedPeer,
  SendTextOptions,
} from './ports.js';
export {
  RateLimiter,
  SendQueue,
  buildShareLinks,
  buildShareReply,
  createShareId,
  parseGetPayload,
} from './shares.js';
