// Dev seed script: inserts demo shares into the local database so the web
// share view can be developed and verified without a live bot.
//
// Usage (from apps/server):
//   pnpm build
//   SANITIZE_SECRET=devsecret DATA_DIR=./data node --experimental-strip-types scripts/seed-share.ts
//
// Seeds two shares: "demo-text" (text/entities/forward origins) and
// "demo-media" (photo/video/round video/voice/sticker/file, hosted from
// scripts/fixtures/). The TL JSON below mirrors what the bot persists (raw
// serialized teleproto messages as received in the bot PM, forwarder id
// 777000); the API sanitizes it at serve time.

import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { openDatabase } from '../dist/storage/database.js';
import {
  createShare,
  deleteShare,
  finalizeShare,
  getShare,
  insertMediaIfAbsent,
  insertMessage,
  linkMediaToShare,
  upsertPeer,
} from '../dist/storage/repository.js';

const FORWARDER = '777000';
const BASE_DATE = 1755000000;
const FIXTURES_DIR = path.join(import.meta.dirname, 'fixtures');

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

function makeMessage(id: number, extra: Record<string, unknown>) {
  return {
    className: 'Message',
    id,
    date: BASE_DATE + id,
    peerId: forwarderPeer(),
    fromId: forwarderPeer(),
    ...extra,
  };
}

const TEXT_MESSAGES = [
  makeMessage(1, { message: 'Hello from the share view 👋' }),
  makeMessage(2, {
    message: 'Bold, italic, code and a link',
    entities: [
      { className: 'MessageEntityBold', offset: 0, length: 4 },
      { className: 'MessageEntityItalic', offset: 6, length: 6 },
      { className: 'MessageEntityCode', offset: 14, length: 4 },
      { className: 'MessageEntityTextUrl', offset: 24, length: 4, url: 'https://telegram.org' },
    ],
  }),
  makeMessage(3, {
    message: 'Forwarded text from a user',
    fwdFrom: fwdFrom({ fromId: { className: 'PeerUser', userId: { $long: PEERS.user.peerId } } }),
  }),
  makeMessage(4, {
    message: 'Forwarded text from a channel',
    fwdFrom: fwdFrom({
      fromId: { className: 'PeerChannel', channelId: { $long: PEERS.channel.peerId } },
      channelPost: 42,
    }),
  }),
  makeMessage(5, {
    message: 'Forwarded text from a hidden user',
    fwdFrom: fwdFrom({ fromName: 'Hidden User' }),
  }),
  makeMessage(6, {
    message: 'Forwarded text from a group',
    fwdFrom: fwdFrom({ fromId: { className: 'PeerChat', chatId: { $long: PEERS.group.peerId } } }),
  }),
];

// --- Media share ------------------------------------------------------------

interface MediaFixture {
  /** Real document/photo id — the global media key */
  id: string;
  file: string;
  mime: string;
  width?: number;
  height?: number;
  thumbFile?: string;
}

const MEDIA = {
  photo: {
    id: '800001', file: 'photo.png', mime: 'image/png', width: 640, height: 360,
  },
  video: {
    id: '800002', file: 'video.mp4', mime: 'video/mp4', width: 640, height: 360, thumbFile: 'thumb.jpg',
  },
  round: {
    id: '800003', file: 'round.mp4', mime: 'video/mp4', width: 240, height: 240,
  },
  voice: { id: '800004', file: 'voice.ogg', mime: 'audio/ogg' },
  sticker: {
    id: '800005', file: 'sticker.webp', mime: 'image/webp', width: 512, height: 512,
  },
  file: { id: '800006', file: 'hello.txt', mime: 'text/plain' },
} satisfies Record<string, MediaFixture>;

function photoMedia(photo: MediaFixture) {
  return {
    className: 'MessageMediaPhoto',
    photo: {
      className: 'Photo',
      id: { $long: photo.id },
      accessHash: { $long: '1' },
      fileReference: { $bytes: 'AAEC' },
      date: BASE_DATE,
      dcId: 4,
      sizes: [
        { className: 'PhotoSize', type: 'm', w: 320, h: 180, size: 1000 },
        { className: 'PhotoSize', type: 'x', w: photo.width, h: photo.height, size: 11000 },
      ],
    },
  };
}

function documentMedia(document: MediaFixture, attributes: unknown[], thumbs?: unknown[]) {
  return {
    className: 'MessageMediaDocument',
    document: {
      className: 'Document',
      id: { $long: document.id },
      accessHash: { $long: '1' },
      fileReference: { $bytes: 'AAEC' },
      date: BASE_DATE,
      dcId: 4,
      size: { $long: String(statSync(path.join(FIXTURES_DIR, document.file)).size) },
      mimeType: document.mime,
      attributes,
      thumbs,
    },
  };
}

const WAVEFORM = Buffer.from(
  Array.from({ length: 100 }, (_, i) => Math.round(31 + 24 * Math.sin(i / 5))),
).toString('base64');

const VIDEO_THUMBS = [{ className: 'PhotoSize', type: 'm', w: 320, h: 180, size: 4805 }];

const MEDIA_MESSAGES = [
  makeMessage(1, { message: 'A photo with caption', media: photoMedia(MEDIA.photo) }),
  makeMessage(2, {
    message: 'A video',
    media: documentMedia(MEDIA.video, [
      {
        className: 'DocumentAttributeVideo', w: 640, h: 360, duration: 3, supportsStreaming: true,
      },
      { className: 'DocumentAttributeFilename', fileName: 'video.mp4' },
    ], VIDEO_THUMBS),
  }),
  makeMessage(3, {
    media: documentMedia(MEDIA.round, [
      {
        className: 'DocumentAttributeVideo', w: 240, h: 240, duration: 2, roundMessage: true,
      },
    ]),
  }),
  makeMessage(4, {
    media: documentMedia(MEDIA.voice, [
      { className: 'DocumentAttributeAudio', duration: 2, voice: true, waveform: { $bytes: WAVEFORM } },
    ]),
  }),
  makeMessage(5, {
    media: documentMedia(MEDIA.sticker, [
      { className: 'DocumentAttributeImageSize', w: 512, h: 512 },
      {
        className: 'DocumentAttributeSticker',
        alt: '😀',
        stickerset: { className: 'InputStickerSetID', id: { $long: '900001' }, accessHash: { $long: '1' } },
      },
    ]),
  }),
  makeMessage(6, {
    message: '',
    media: documentMedia(MEDIA.file, [
      { className: 'DocumentAttributeFilename', fileName: 'hello.txt' },
    ]),
  }),
];

function seedShare(db: ReturnType<typeof openDatabase>, shareId: string, messages: unknown[]): void {
  if (getShare(db, shareId) !== null) {
    deleteShare(db, shareId, FORWARDER);
  }
  createShare(db, { id: shareId, ownerUserId: FORWARDER });
  messages.forEach((message, index) => {
    insertMessage(db, { shareId, seq: index + 1, tlJson: JSON.stringify(message) });
  });
  Object.values(PEERS).forEach((peer) => {
    upsertPeer(db, { shareId, ...peer });
  });
  finalizeShare(db, shareId);
  console.log(`Seeded share "${shareId}" with ${messages.length} messages`);
}

function main(): void {
  const dataDir = process.env.DATA_DIR || './data';
  const db = openDatabase(path.join(dataDir, 'tbfb.db'));

  seedShare(db, 'demo-text', TEXT_MESSAGES);
  seedShare(db, 'demo-media', MEDIA_MESSAGES);

  const mediaDir = path.join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });
  Object.values(MEDIA).forEach((fixture) => {
    for (const file of [fixture.file, fixture.thumbFile]) {
      if (file) copyFileSync(path.join(FIXTURES_DIR, file), path.join(mediaDir, file));
    }
    insertMediaIfAbsent(db, {
      key: fixture.id,
      mime: fixture.mime,
      size: statSync(path.join(FIXTURES_DIR, fixture.file)).size,
      path: `media/${fixture.file}`,
      hosted: true,
      width: fixture.width,
      height: fixture.height,
      thumbPath: fixture.thumbFile ? `media/${fixture.thumbFile}` : undefined,
    });
    linkMediaToShare(db, 'demo-media', fixture.id);
  });
}

main();
