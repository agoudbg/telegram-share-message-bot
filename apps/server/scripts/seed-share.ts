// Dev seed script: inserts a demo text-only share into the local database so
// the web share view can be developed and verified without a live bot.
//
// Usage (from apps/server):
//   pnpm build
//   SANITIZE_SECRET=devsecret DATA_DIR=./data node --experimental-strip-types scripts/seed-share.ts [shareId]
//
// The TL JSON below mirrors what the bot persists (raw serialized teleproto
// messages as received in the bot PM, forwarder id 777000); the API sanitizes
// it at serve time.

import path from 'node:path';

import { openDatabase } from '../dist/storage/database.js';
import {
  createShare, deleteShare, finalizeShare, getShare, insertMessage, upsertPeer,
} from '../dist/storage/repository.js';

const FORWARDER = '777000';
const BASE_DATE = 1755000000;

const PEERS = {
  user: { peerId: '111111', kind: 'user', displayName: 'Alice Example', username: 'aliceexample' },
  channel: {
    peerId: '222222', kind: 'channel', displayName: 'Example Channel', username: 'examplechannel',
  },
  group: { peerId: '333333', kind: 'chat', displayName: 'Example Group' },
} as const;

function forwarderPeer() {
  return { className: 'PeerUser', userId: { $long: FORWARDER } };
}

function fwdFrom(extra: Record<string, unknown>) {
  return { className: 'MessageFwdHeader', date: BASE_DATE - 1000, ...extra };
}

const MESSAGES: Array<Record<string, unknown>> = [
  {
    id: 1,
    message: 'Hello from the share view 👋',
  },
  {
    id: 2,
    message: 'Bold, italic, code and a link',
    entities: [
      { className: 'MessageEntityBold', offset: 0, length: 4 },
      { className: 'MessageEntityItalic', offset: 6, length: 6 },
      { className: 'MessageEntityCode', offset: 14, length: 4 },
      { className: 'MessageEntityTextUrl', offset: 24, length: 4, url: 'https://telegram.org' },
    ],
  },
  {
    id: 3,
    message: 'Forwarded text from a user',
    fwdFrom: fwdFrom({ fromId: { className: 'PeerUser', userId: { $long: PEERS.user.peerId } } }),
  },
  {
    id: 4,
    message: 'Forwarded text from a channel',
    fwdFrom: fwdFrom({
      fromId: { className: 'PeerChannel', channelId: { $long: PEERS.channel.peerId } },
      channelPost: 42,
    }),
  },
  {
    id: 5,
    message: 'Forwarded text from a hidden user',
    fwdFrom: fwdFrom({ fromName: 'Hidden User' }),
  },
  {
    id: 6,
    message: 'Forwarded text from a group',
    fwdFrom: fwdFrom({ fromId: { className: 'PeerChat', chatId: { $long: PEERS.group.peerId } } }),
  },
];

function main(): void {
  const shareId = process.argv[2] || 'demo-text';
  const dataDir = process.env.DATA_DIR || './data';
  const db = openDatabase(path.join(dataDir, 'tbfb.db'));

  if (getShare(db, shareId) !== null) {
    deleteShare(db, shareId, FORWARDER);
  }
  createShare(db, { id: shareId, ownerUserId: FORWARDER });

  MESSAGES.forEach((message, index) => {
    const { id, ...rest } = message;
    insertMessage(db, {
      shareId,
      seq: index + 1,
      tlJson: JSON.stringify({
        className: 'Message',
        id,
        date: BASE_DATE + (id as number),
        peerId: forwarderPeer(),
        fromId: forwarderPeer(),
        ...rest,
      }),
    });
  });

  Object.values(PEERS).forEach((peer) => {
    upsertPeer(db, { shareId, ...peer });
  });

  finalizeShare(db, shareId);
  console.log(`Seeded share "${shareId}" with ${MESSAGES.length} messages in ${dataDir}`);
}

main();
