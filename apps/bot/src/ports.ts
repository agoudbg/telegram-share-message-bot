// Ports decoupling the bot core from teleproto. The real implementations
// live in main.ts; tests inject fakes. Keeping the core teleproto-free makes
// the batching engine, media pipeline and share flows unit-testable.

import type { TLJsonObject } from '@tbfb/tlbridge';

/** A private-chat message normalized for the bot core. */
export interface NormalizedMessage {
  /** Sender user id (decimal string); also the PM chat id for bots */
  chatId: string;
  messageId: number;
  text: string;
  isPrivate: boolean;
  isForward: boolean;
  groupedId?: string;
  /** Serialized TL JSON of the whole message (tlbridge serializeTL) */
  tlJson: TLJsonObject;
  /** The original Api.Message, opaque to the core */
  raw: unknown;
}

export interface SendTextOptions {
  /** Attach the "Done — generate link" inline callback button */
  doneButton?: boolean;
  /** Attach an inline WebApp button opening the share page */
  webAppButton?: { text: string; url: string };
}

/** Everything needed to re-send an unhosted file server-side
 *  (docs/PLAN.md §2.5): the InputDocument reference. */
export interface InputDocumentRef {
  id: string;
  accessHash: string;
  /** base64 */
  fileReference: string;
}

export interface InputPhotoRef {
  id: string;
  accessHash: string;
  /** base64 */
  fileReference: string;
}

export interface ResolvedPeer {
  kind: 'user' | 'chat' | 'channel';
  displayName: string;
  username?: string;
  hasAvatar: boolean;
}

export interface BotPorts {
  /** Returns the sent message id (for later edits), when available */
  sendText(chatId: string, text: string, opts?: SendTextOptions): Promise<number | undefined>;
  editText(chatId: string, messageId: number, text: string): Promise<void>;
  /** Re-send an unhosted file by reusing its InputDocument reference */
  sendDocumentByRef(chatId: string, ref: InputDocumentRef, caption?: string): Promise<void>;
  /** Delete bot messages (best effort: the collecting prompt and the
   *  processing status are removed once a share is ready) */
  deleteMessages(chatId: string, messageIds: number[]): Promise<void>;
  /** null = unresolvable (e.g. a channel the bot is not in) */
  resolvePeer(peerId: string): Promise<ResolvedPeer | null>;
}
