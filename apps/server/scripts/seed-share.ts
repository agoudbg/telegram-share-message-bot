// Dev seed script: inserts demo shares into the local database so the web
// share view can be developed and verified without a live bot.
//
// Usage (from apps/server):
//   pnpm build
//   SANITIZE_SECRET=devsecret DATA_DIR=./data node --experimental-strip-types scripts/seed-share.ts
//
// Seeds three shares: "demo-text" (text/entities/forward origins, incl. one
// nestedForward-flagged message), "demo-media" (photo/video/round video/
// voice/sticker/file, hosted from scripts/fixtures/) and "demo-unhosted"
// (hosted:false media: a retrievable video and a non-retrievable photo).
// The TL JSON below mirrors what the bot persists (raw
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

// A message whose fwdFrom.date is strictly earlier than the previous one
// would be flagged nestedForward by the bot heuristic (docs/PLAN.md §2.7);
// here the flag is set directly in seedShare below
const NESTED_MESSAGE = makeMessage(7, {
  message: 'Nested forward (degrades to a non-clickable origin)',
  fwdFrom: {
    ...fwdFrom({ fromId: { className: 'PeerUser', userId: { $long: PEERS.user.peerId } } }),
    date: BASE_DATE - 5000,
  },
});

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
  photo2: {
    id: '800009', file: 'photo.png', mime: 'image/png', width: 640, height: 360,
  },
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

// --- Unhosted media share ----------------------------------------------------

const UNHOSTED = {
  video: {
    id: '800007', file: 'video.mp4', mime: 'video/mp4', width: 640, height: 360, thumbFile: 'thumb.jpg',
  },
  photo: {
    id: '800008', file: 'photo.png', mime: 'image/png', width: 640, height: 360,
  },
} satisfies Record<string, MediaFixture>;

// Mirrors the InputDocument JSON the bot persists for oversized files; only
// its presence matters here (it makes the media row `retrievable`)
const FAKE_REFERENCE = JSON.stringify({
  className: 'InputDocument',
  id: { $long: '800007' },
  accessHash: { $long: '1' },
  fileReference: { $bytes: 'AAEC' },
});

const UNHOSTED_MESSAGES = [
  makeMessage(1, {
    message: 'Oversized video (retrievable via the bot)',
    media: documentMedia(UNHOSTED.video, [
      {
        className: 'DocumentAttributeVideo', w: 640, h: 360, duration: 3, supportsStreaming: true,
      },
      { className: 'DocumentAttributeFilename', fileName: 'video.mp4' },
    ], VIDEO_THUMBS),
  }),
  makeMessage(2, {
    media: photoMedia(UNHOSTED.photo),
  }),
];

// --- Type-coverage share (commit 18 matrix) ---------------------------------

function textWithEntities(text: string, entities: unknown[] = []) {
  return { className: 'TextWithEntities', text, entities };
}

function pollAnswer(text: string, optionB64: string) {
  return {
    className: 'PollAnswer',
    text: textWithEntities(text),
    option: { $bytes: optionB64 },
  };
}

function messagePoll(question: string, answers: string[]) {
  return {
    className: 'MessageMediaPoll',
    poll: {
      className: 'Poll',
      id: { $long: '900011' },
      question: textWithEntities(question),
      answers: answers.map((text, i) => pollAnswer(text, Buffer.from([i]).toString('base64'))),
      hash: { $long: '1' },
    },
    results: {
      className: 'PollResults',
      results: [],
      totalVoters: 0,
    },
  };
}

function messageGeo(lng: number, lat: number) {
  return {
    className: 'MessageMediaGeo',
    geo: {
      className: 'GeoPoint',
      long: lng,
      lat,
      accessHash: { $long: '1' },
      accuracyRadius: 100,
    },
  };
}

function messageContact(firstName: string, lastName: string, phoneNumber: string) {
  return {
    className: 'MessageMediaContact',
    phoneNumber,
    firstName,
    lastName,
    vcard: '',
    userId: { $long: '111111' },
  };
}

const ALBUM_GROUP_ID = '777000777';

const TYPES_MESSAGES = [
  makeMessage(1, { message: 'Plain text message' }),
  makeMessage(2, {
    message: 'Bold, italic, code and a link',
    entities: [
      { className: 'MessageEntityBold', offset: 0, length: 4 },
      { className: 'MessageEntityItalic', offset: 6, length: 6 },
      { className: 'MessageEntityCode', offset: 14, length: 4 },
      { className: 'MessageEntityTextUrl', offset: 24, length: 4, url: 'https://telegram.org' },
    ],
  }),
  makeMessage(3, { message: 'A photo with caption', media: photoMedia(MEDIA.photo) }),
  // Album: two photos sharing one groupedId
  makeMessage(4, {
    media: photoMedia(MEDIA.photo2),
    groupedId: { $long: ALBUM_GROUP_ID },
  }),
  makeMessage(5, {
    media: photoMedia(MEDIA.photo),
    groupedId: { $long: ALBUM_GROUP_ID },
  }),
  makeMessage(6, {
    message: 'A video',
    media: documentMedia(MEDIA.video, [
      {
        className: 'DocumentAttributeVideo', w: 640, h: 360, duration: 3, supportsStreaming: true,
      },
      { className: 'DocumentAttributeFilename', fileName: 'video.mp4' },
    ], VIDEO_THUMBS),
  }),
  makeMessage(7, {
    media: documentMedia(MEDIA.file, [
      { className: 'DocumentAttributeFilename', fileName: 'hello.txt' },
    ]),
  }),
  makeMessage(8, {
    media: documentMedia(MEDIA.sticker, [
      { className: 'DocumentAttributeImageSize', w: 512, h: 512 },
      {
        className: 'DocumentAttributeSticker',
        alt: '😀',
        stickerset: { className: 'InputStickerSetID', id: { $long: '900001' }, accessHash: { $long: '1' } },
      },
    ]),
  }),
  makeMessage(9, {
    media: documentMedia(MEDIA.voice, [
      { className: 'DocumentAttributeAudio', duration: 2, voice: true, waveform: { $bytes: WAVEFORM } },
    ]),
  }),
  makeMessage(10, {
    media: documentMedia(MEDIA.round, [
      {
        className: 'DocumentAttributeVideo', w: 240, h: 240, duration: 2, roundMessage: true,
      },
    ]),
  }),
  makeMessage(11, {
    media: messagePoll('Best framework?', ['Vue', 'React', 'Svelte']),
  }),
  makeMessage(12, {
    media: messageGeo(37.7749, 122.4194),
  }),
  makeMessage(13, {
    media: messageContact('Alice', 'Example', '+1 555 0100'),
  }),
  makeMessage(14, {
    message: 'Replying to the first message',
    replyTo: { className: 'MessageReplyHeader', replyToMsgId: 1 },
  }),
  makeMessage(15, {
    className: 'MessageService',
    id: 900,
    date: BASE_DATE + 900,
    peerId: forwarderPeer(),
    fromId: forwarderPeer(),
    action: { className: 'MessageActionChatEditTitle', title: 'Group renamed to Test' },
  }),
  makeMessage(16, {
    message: 'Forwarded from a user',
    fwdFrom: fwdFrom({ fromId: { className: 'PeerUser', userId: { $long: PEERS.user.peerId } } }),
  }),
  makeMessage(17, {
    message: 'Forwarded from a channel',
    fwdFrom: fwdFrom({
      fromId: { className: 'PeerChannel', channelId: { $long: PEERS.channel.peerId } },
      channelPost: 42,
    }),
  }),
  makeMessage(18, {
    message: 'Forwarded from a hidden user',
    fwdFrom: fwdFrom({ fromName: 'Hidden User' }),
  }),
  makeMessage(19, {
    message: 'Forwarded from a group',
    fwdFrom: fwdFrom({ fromId: { className: 'PeerChat', chatId: { $long: PEERS.group.peerId } } }),
  }),
  makeMessage(20, {
    message: 'Oversized file placeholder',
    media: documentMedia(UNHOSTED.video, [
      {
        className: 'DocumentAttributeVideo', w: 640, h: 360, duration: 3, supportsStreaming: true,
      },
      { className: 'DocumentAttributeFilename', fileName: 'video.mp4' },
    ], VIDEO_THUMBS),
  }),
];

const TYPE_BATCHES: Record<string, unknown[]> = {
  text: [TYPES_MESSAGES[0]],
  entities: [TYPES_MESSAGES[1]],
  photo: [TYPES_MESSAGES[2]],
  album: TYPES_MESSAGES.slice(3, 5),
  video: [TYPES_MESSAGES[5]],
  file: [TYPES_MESSAGES[6]],
  sticker: [TYPES_MESSAGES[7]],
  voice: [TYPES_MESSAGES[8]],
  round: [TYPES_MESSAGES[9]],
  poll: [TYPES_MESSAGES[10]],
  location: [TYPES_MESSAGES[11]],
  contact: [TYPES_MESSAGES[12]],
  reply: [TYPES_MESSAGES[0], TYPES_MESSAGES[13]],
  service: [TYPES_MESSAGES[14]],
  forwards: TYPES_MESSAGES.slice(15, 19),
  nested: [NESTED_MESSAGE],
  unhosted: [TYPES_MESSAGES[19]],
};

function seedShare(db: ReturnType<typeof openDatabase>, shareId: string, messages: unknown[]): void {
  if (getShare(db, shareId) !== null) {
    deleteShare(db, shareId, FORWARDER);
  }
  createShare(db, { id: shareId, ownerUserId: FORWARDER });
  messages.forEach((message, index) => {
    insertMessage(db, {
      shareId,
      seq: index + 1,
      tlJson: JSON.stringify(message),
      nestedForward: message === NESTED_MESSAGE,
    });
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

  seedShare(db, 'demo-text', [...TEXT_MESSAGES, NESTED_MESSAGE]);
  seedShare(db, 'demo-media', MEDIA_MESSAGES);
  seedShare(db, 'demo-unhosted', UNHOSTED_MESSAGES);
  Object.entries(TYPE_BATCHES).forEach(([type, messages]) => {
    seedShare(db, `demo-type-${type}`, messages);
  });
  // Seed the aggregate matrix last: repeated media keys are linked to all
  // per-type shares above, and SQLite's cascade from deleteShare must not
  // remove those media rows after they have been linked
  seedShare(db, 'demo-types', TYPES_MESSAGES);

  const mediaDir = path.join(dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  // Hosted fixtures (photo.png doubles as photo2)
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
    linkMediaToShare(db, 'demo-types', fixture.id);
    for (const type of ['photo', 'album', 'video', 'file', 'sticker', 'voice', 'round']) {
      linkMediaToShare(db, `demo-type-${type}`, fixture.id);
    }
  });

  // Unhosted rows: flagged hosted:false, no file on disk; the video keeps its
  // InputDocument reference (retrievable), the photo does not
  insertMediaIfAbsent(db, {
    key: UNHOSTED.video.id,
    mime: UNHOSTED.video.mime,
    size: 734003200,
    hosted: false,
    reference: FAKE_REFERENCE,
    width: UNHOSTED.video.width,
    height: UNHOSTED.video.height,
  });
  linkMediaToShare(db, 'demo-unhosted', UNHOSTED.video.id);
  linkMediaToShare(db, 'demo-types', UNHOSTED.video.id);
  linkMediaToShare(db, 'demo-type-unhosted', UNHOSTED.video.id);
  insertMediaIfAbsent(db, {
    key: UNHOSTED.photo.id,
    mime: UNHOSTED.photo.mime,
    size: 524288000,
    hosted: false,
    width: UNHOSTED.photo.width,
    height: UNHOSTED.photo.height,
  });
  linkMediaToShare(db, 'demo-unhosted', UNHOSTED.photo.id);
}

main();
