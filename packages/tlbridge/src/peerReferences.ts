import type { TLJsonObject, TLJsonValue } from './types.js';
import { isTLJsonLong } from './types.js';

export type TLPeerKind = 'user' | 'chat' | 'channel';

export interface TLPeerReference {
  peerId: string;
  kind: TLPeerKind;
}

export const PEER_WRAPPER_ID_FIELDS: Readonly<Record<string, { field: string; kind: TLPeerKind }>> = {
  PeerUser: { field: 'userId', kind: 'user' },
  PeerChat: { field: 'chatId', kind: 'chat' },
  PeerChannel: { field: 'channelId', kind: 'channel' },
};

export const BARE_PEER_ID_FIELDS: Readonly<Record<string, TLPeerKind>> = {
  adminDisallowedChatId: 'chat',
  channelId: 'channel',
  chatId: 'chat',
  inviterId: 'user',
  linkedChatId: 'channel',
  migratedFromChatId: 'chat',
  userId: 'user',
  userIdHint: 'user',
  viaBotId: 'user',
  viaBusinessBotId: 'user',
};

export const BARE_PEER_ID_VECTOR_FIELDS: Readonly<Record<string, TLPeerKind>> = {
  channels: 'channel',
  chats: 'chat',
  excludeUsers: 'user',
  users: 'user',
  winners: 'user',
};

const MESSAGE_CLASSES = new Set(['Message', 'MessageService']);
const MESSAGE_IDENTITY_FIELDS = new Set(['peerId', 'fromId', 'savedPeerId']);

export function collectReferencedPeers(value: TLJsonValue): TLPeerReference[] {
  const references = new Map<string, TLPeerReference>();
  visit(value);
  return [...references.values()];

  function addReference(rawId: TLJsonValue, kind: TLPeerKind) {
    const peerId = getId(rawId);
    if (peerId === undefined) return;
    references.set(`${kind}:${peerId}`, { peerId, kind });
  }

  function visit(current: TLJsonValue) {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== 'object' || current === null || isTLJsonLong(current) || '$bytes' in current) return;

    const object = current as TLJsonObject;
    const className = object.className;
    const peerWrapper = className === undefined ? undefined : PEER_WRAPPER_ID_FIELDS[className];
    if (peerWrapper !== undefined) {
      const rawId = object[peerWrapper.field];
      if (rawId !== undefined) addReference(rawId, peerWrapper.kind);
      return;
    }

    const isMessage = className !== undefined && MESSAGE_CLASSES.has(className);
    for (const [field, child] of Object.entries(object)) {
      if (field === 'className' || child === undefined) continue;
      if (isMessage && MESSAGE_IDENTITY_FIELDS.has(field)) continue;

      const scalarKind = BARE_PEER_ID_FIELDS[field];
      if (scalarKind !== undefined && isId(child)) {
        addReference(child, scalarKind);
        continue;
      }

      const vectorKind = BARE_PEER_ID_VECTOR_FIELDS[field];
      if (vectorKind !== undefined && Array.isArray(child)) {
        child.forEach((item) => {
          if (isId(item)) addReference(item, vectorKind);
          else visit(item);
        });
        continue;
      }

      visit(child);
    }
  }
}

function isId(value: TLJsonValue): boolean {
  return typeof value === 'number' || isTLJsonLong(value);
}

function getId(value: TLJsonValue): string | undefined {
  if (isTLJsonLong(value)) return value.$long;
  return typeof value === 'number' ? value.toString() : undefined;
}
