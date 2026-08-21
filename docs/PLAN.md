# Implementation Plan (v5, approved baseline)

> This document is the project's authoritative design reference. During
> implementation, align with it first; if a deviation proves necessary,
> update this document in the same change.

## 1. Goal

A user forwards multiple messages to the bot → the bot groups them into one
batch → it produces a publicly shareable web page (also a Mini App) → the
page reproduces the messages as faithfully as possible using the official
Telegram WebA (telegram-tt) rendering pipeline.

## 2. Architecture decisions (all verified)

### 2.1 Core pipeline: backend and frontend run the same MTProto client family; TL data flows through with zero semantic conversion

- **WebA speaks MTProto, not TDLib**: it embeds a GramJS fork
  (`src/lib/gramjs/`) as its MTProto client. TDLib is a separate C++ wrapper
  exposing only its private td_api JSON schema (raw TL is unreachable through
  it) and plays no part in this project.
- **The backend uses teleproto (the maintained successor fork of
  gram-js/gramjs) with bot-token MTProto login** (`client.start({
botAuthToken })`, under the hood `auth.ImportBotAuthorization`) — same
  protocol, same TL schema, same library family as WebA.
- Data flow:

```
Telegram servers
   │ MTProto                        │ MTProto
   ▼                                ▼
teleproto (backend bot session)  WebA's embedded GramJS fork (frontend)
   │ raw TL messages                ▲ hydrate back into GramJs instances
   │ TL JSON serialization ──(HTTP)──▶ frontend ┘
   ▼                                ▼
SQLite stores raw TL JSON      buildApiMessage → official render pipeline
```

- **We do not hand-implement any message-format semantic conversion.** New
  message types follow naturally as the upstream TL layer advances; the
  hydrator degrades unknown constructors gracefully.
- WebA rendering layers and our injection point:

```
① src/lib/gramjs/      GramJS deserialization → TL class instances
② src/api/gramjs/apiBuilders/messages.ts   buildApiMessage(TL) → ApiMessage   ◄══ injection point
③ src/global/          reducers into global state
④ src/components/middle/ React renders DOM
```

- Bots download via MTProto `upload.getFile` with **no Bot-API 20MB
  artificial limit** (the ceiling is Telegram's own 2GB/4GB), with
  chunked/resumable downloads.
- Requires `api_id/api_hash` from my.telegram.org (mandatory for MTProto).

### 2.2 TL layer tracking strategy (can the fork keep up with Telegram?)

Verified findings:

- **teleproto is currently at layer 228, one ahead of WebA's embedded gramjs
  (227)**; npm releases land every few days and the version encodes the layer
  (`1.228.5`); it ships a full TL generation pipeline (`teleproto_generator/`
  - `static/tl/api.tl` → `npm run generate:tl`); since 2025-05 it has tracked
    roughly one layer per month with no sign of falling behind.
- **How WebA itself does it**: manually sync the official `api.tl`
  (`src/lib/gramjs/tl/static/api.tl`) → run the `gramjs:tl` generator script;
  27 layer bumps in 14 months, about 1–2 per month.
- **Unknown constructors are not catastrophic**: deserialization of a new
  constructor only drops that one update (logged as `Type ... not found`);
  the connection stays up and pts gaps are repaired via `getDifference`. The
  core types on a bot's message path (Message/User/Chat/Channel/Document/
  Photo) are the most stable part of TL and have not changed in years.
- Strategy derived from this:
  1. Pin the minor (`~1.228.x`), upgrade routinely once a month;
  2. **Alert on teleproto log lines `Type ... not found` /
     `Unknown constructor`** — that is the "time to upgrade" detector, more
     direct than watching layer numbers;
  3. Contingency (if teleproto stops being maintained): drop the official
     Telegram `api.tl` into `teleproto_generator`, run `generate:tl`, publish
     an internal build. Do **not** carve WebA's gramjs out to run in Node
     (it is coupled to WebA app code: util imports, browser WebSocket
     wrappers).

### 2.3 Frontend: fork WebA (telegram-tt), not WebK

- Ships the official TL→ApiMessage converter `buildApiMessage`
  (`src/api/gramjs/apiBuilders/messages.ts:149`)
- Official login-free mock mode `IS_MOCKED_CLIENT` (`src/config.ts`) +
  `dev:mocked`/`build:mocked`
- Media short-circuit via `blobUrl`/`thumbnail.dataUri` (e.g.
  `Photo.tsx:102`): pointing those at our backend URLs bypasses the MTProto
  download layer entirely
- Layered architecture → cheap upstream merges; WebK is
  ten-thousand-line single files + mid-migration to SolidJS + Service-Worker
  coupling

### 2.4 TL JSON bridge (tlbridge — the project's only self-built conversion layer; mechanical in both directions)

Verified serialization facts:

- GramJS TL fields are camelCase (`fwdFrom`/`fromId`/`fromName`), matching
  what the WebA fork reads; the constructor marker is `className`
- Event messages carry runtime fields (`_client`/`_entities`, …) with
  circular references → the serializer replacer strips underscore-prefixed
  fields
- longs: teleproto big-integer → `{"$long":"…"}`; the frontend hydrates to
  native `bigint` (the WebA fork does arithmetic like `id * -1n`)
- bytes: → `{"$bytes":"base64"}`; the frontend restores `Uint8Array`
- `buildApiMessage` discriminates entirely via `instanceof` and WebA has no
  ready-made JSON→TL deserializer → the frontend hydrator recursively
  instantiates constructors from the fork's `AllTLObjects` table by
  `className`; the render path never calls TL binary methods, so this works

### 2.5 On-demand Telegram media with a bounded local cache

Share creation persists media metadata and refreshable MTProto locators, not
file bytes. A locator contains the known incoming bot-dialog message id plus
the current Document/Photo reference. On the first viewer request, the bot
uses `messages.getMessages` to retrieve that exact known message id, refreshes
the file reference, and streams the file to the HTTP server. Bots may use
`messages.getMessages`; they may not enumerate history with
`messages.getHistory`, so source message ids are mandatory.

- The HTTP server tails the growing download for the first viewer and commits
  it atomically to a read-through cache when complete.
- The cache defaults to a 24-hour idle TTL and a 5 GiB hard limit. Expired
  entries are removed first; capacity pressure evicts LRU entries to 4 GiB.
- Concurrent requests for the same media/variant share one Telegram download.
- Telegram downloads time out and are cancelled when their last viewer disconnects.
- Public media requests and bandwidth use independent per-share and per-client token buckets.
- Full media, thumbnails, and resolvable origin avatars use the same cache.
- The existing `get_<shareId>_<seq>` deep link remains a last-resort document
  delivery path when the web download cannot be recovered.

### 2.6 Security (public pages only ever get sanitized copies)

- The DB stores raw TL; **the external API only serves sanitized copies**:
  strip `accessHash`/`fileReference`/`dcId` (media is hosted by us; the
  frontend uses blobUrl); remap real user/channel/chat ids to fake ids via
  share-scoped HMAC-SHA256 (keyed per share, valid int64, not correlatable
  across shares); erase the forwarder's identity; keep `fwdFrom.fromName`
  (hidden users)
- The sanitizer instance is per-share state: the server must create a fresh
  instance per share and never reuse one across shares (the internal id map
  would otherwise correlate different shares)
- bot token / StringSession / api_hash live only on the server
- Full message text and origin names are public by design (that is the
  product); the README states this plainly

### 2.7 Nested-forward heuristic (strictly-earlier only)

APIs flatten forward chains to the earliest visible origin, so "a forward of
a forward" cannot be identified with certainty. Heuristic: within a batch in
arrival order, if a message's `fwdFrom.date` is **strictly earlier** than the
previous message's (`next < prev`) → mark `nestedForward` → render it in
"forwarded message" form with the intermediate forwarder hidden.

- **No equality**: TL timestamps have second precision and adjacent messages
  in one batch very often share a second; treating equality as nested would
  cause many false positives. Only "clearly earlier" is a reliable
  time-reversal signal.
- Display timestamps remain nondecreasing in batch order: the web adapter uses
  each message's original `fwdFrom.date` when possible, but clamps a backward
  value to the previous displayed timestamp. This prevents flattened nested
  forwards from producing backward date separators while retaining the true
  source timestamp in `forwardInfo.date`.
- Pure function + configurable switch; the UI never states the verdict
  absolutely.

### 2.8 Miscellaneous

- Share pages are public by default; random unguessable share ids; `/delete`
  revokes (404)
- Every Share View message list begins with an English service notice warning
  that messages may have been excerpted, mixed, or tampered with and are for
  reference only. Its `Learn More` link opens the GitHub-hosted authenticity
  help page in the system browser.
- telegram-tt is GPL-3.0-or-later → the repo is published as GPL-3.0
- Avatars: fetched via `downloadProfilePhoto` when the origin is resolvable;
  unresolvable origins (e.g. channels the bot is not in) fall back to letter
  avatars; hidden users have names only
- Forward origins: raw `fwdFrom` fields map one-to-one onto what WebA's
  `buildApiMessageForwardInfo` reads — a natural fit
- `TELEGRAM_TEST_SERVER=1` points the bot at the Telegram test DCs
  (teleproto `testServers` flag) for development — a fully separate
  environment with its own bot token, session and data directory; test DCs
  allow plain-HTTP web origins, which simplifies Mini App testing

## 3. Overall architecture

```
├── apps/
│   ├── bot/            # teleproto bot: MTProto login, updates, batching, media, shares, fallback delivery
│   ├── server/         # HTTP: share API (sanitized TL JSON) + media streaming + serves the web build
│   └── web/            # telegram-tt fork (submodule → our fork, share-view branch tracking upstream)
├── packages/
│   └── tlbridge/       # TL JSON serialize/hydrate, sanitizer, forward heuristic, share-id utils (shared)
├── deploy/
│   ├── systemd/        # preferred source deployment service
│   ├── nginx/          # host reverse-proxy example
│   └── start-app.mjs   # bot + server process supervisor
└── README.md / LICENSE (GPL-3.0) / docs/UPSTREAM.md
```

Storage: SQLite (better-sqlite3, WAL) + bounded disposable files under
`data/cache/media/`; the repository layer is isolated so Postgres can replace
it later.

## 4. Step-by-step plan (each step = one independent commit)

### Phase 0 — Scaffolding

**Commit 1 — `chore: project scaffolding`**

- pnpm workspace, tsconfig, eslint+prettier, vitest, env template
- README: api_id/api_hash from my.telegram.org, BotFather bot,
  `API_ID/API_HASH/BOT_TOKEN/SESSION` configuration
- Acceptance: `pnpm -r build` passes

### Phase 1 — tlbridge (pure functions, heavily tested)

**Commit 2 — `feat(tlbridge): TL JSON serialize/hydrate bridge`**

- Serializer: strip `_*` fields, tag longs/bytes, keep className; hydrator:
  className→constructor recursive instantiation, bigint/Uint8Array revival,
  unknown-constructor degradation
- Acceptance: round-trip unit tests on real captured TL objects

**Commit 3 — `feat(tlbridge): TL sanitizer`**

- Strip accessHash/fileReference/dcId; share-scoped HMAC fake-id mapping
  (consistent references across users/chats/photos/documents); erase the
  forwarder; keep fromName
- Acceptance: fixture unit tests (same user → same fake id within a share,
  different across shares)

**Commit 4 — `feat(tlbridge): forward-origin extraction and nested-forward heuristic`**

- Four fwdFrom states (user/hidden_user/chat/channel+channel_post);
  **strictly-earlier** (`next.date < prev.date`) marks nestedForward, equal
  never does; configurable switch
- Acceptance: unit tests for decreasing/increasing/**same-second adjacency**
  (must not false-positive)

### Phase 2 — Bot and storage

**Commit 5 — `feat(bot): teleproto bot skeleton`**

- Bot token login, StringSession persistence, reconnect, FloodWait
  absorption, SendMessage/KeyboardButton wrappers, /start /help /privacy
- Unknown-constructor logs (`Type ... not found`) emitted to a dedicated
  channel for alerting (§2.2)
- Acceptance: /start gets a reply

**Commit 6 — `feat(server): SQLite storage layer`**

- Migrations: shares, messages (share_id, seq, tl_json, nested_forward),
  media (key, mime, size, path, hosted, reference JSON), peers (real peer id
  → display name/avatar key; the fake-id remap happens at serve time, same
  as messages — sanitization stays in exactly one place, §5)
- Acceptance: in-memory SQLite unit tests

**Commit 7 — `feat(bot): forward batching engine`**

- Consecutive forwards from one user: sliding silence window (default ~10s,
  configurable) + a "✅ Done, generate link" button to finish immediately +
  /cancel; groupedId albums keep order; each message is serialized +
  heuristically marked + persisted into the in-progress batch
- Acceptance: fake-timer integration tests

**Commit 8 — `feat(bot): on-demand media source registration`**

- Persist Document/Photo ids, exact incoming message ids, references, mime and
  dimensions without downloading bytes during share creation.
- Resolve forward origins and register avatar locators; unresolvable origins
  continue to use the frontend letter fallback.
- Acceptance: forwarding image/video/file messages writes metadata and source
  rows while leaving the cache directory empty.

**Commit 9 — `feat(bot): share creation, reply and document fallback`**

- Finish → random share id → public → reply with: HTTPS link +
  `t.me/<bot>/<app>?startapp=<id>` direct link + inline
  `KeyboardButtonWebView` button; /delete revokes
- `/start get_<shareId>_<seq>` payload → verify public → re-send the file by
  reusing the InputDocument (FloodWait queue + rate limit)
- Acceptance: manual end-to-end (API returning JSON suffices before web is
  ready)

### Phase 3 — Server API

**Commit 10 — `feat(server): share data API`**

- Hono: `GET /api/shares/:id` → sanitized TL JSON array + peers + media map
  (incl. hosted flags)
- Implementation details settled here: the media map is keyed by share-scoped
  fake media keys (matching the sanitized Photo/Document `id` the frontend
  sees); a `share_media` link table records which media each share references
  (media files stay globally deduped by key); the sanitizer's shareSecret is
  `SANITIZE_SECRET:shareId` (new env var); pending shares answer 404 like
  unknown ones, revoked ones 410
- Acceptance: curl verifies JSON shape and that sensitive fields are gone

**Commit 11 — `feat(server): media streaming endpoint`**

- `GET /media/:shareId/:key`: Range support, correct Content-Type, strong
  caching, 404/410
- `:key` is the share-scoped fake media key from the Commit 10 media map
  (resolved back per share; real ids never appear in URLs); thumbnails are
  served via `?thumb=1`
- Acceptance: curl Range requests, content-type checks

### Phase 4 — Web frontend (telegram-tt fork)

**Commit 12 — `feat(web): telegram-tt fork + mocked build`**

- Submodule pointing at our fork's `share-view` branch; first fork commit:
  `APP_MOCKED_CLIENT` build, login stripped, new `/s/:shareId` route
- Acceptance: `pnpm build` yields static assets, opening shows an empty
  message area

**Commit 13 — `feat(web): data injection (hydration + fetchMessages replacement + peer injection)`**

- New code concentrated in `apps/web/src/api/share/`: tlbridge hydrator
  wired in, fetchMessages replaced by calls to `/api/shares/:id`,
  updateUsers/updateChats inject origin peers, a virtual read-only chat
- Acceptance: the page renders a test batch (text first)

**Commit 14 — `feat(web): media blobUrl short-circuit`**

- Fill `blobUrl`/`thumbnail.dataUri` on ApiPhoto/ApiVideo/ApiDocument →
  `/media/:shareId/:key`; minimal patches to skip mediaLoader where needed;
  origin-peer avatars point at `/media/...` (moved here from commit 13: the
  mechanism depends on this commit's media URL wiring)
- Acceptance: images/videos/stickers/voice/round video all display/play

**Commit 15 — `feat(web): "View in Telegram" placeholder for unavailable media`**

- hosted:false media renders an official-style placeholder bubble + button
  (t.me deep link `?start=get_…`)
- Acceptance: placeholder renders and navigates correctly

**Commit 16 — `feat(web): forward-origin and nested-forward rendering`**

- Default: original origin name + avatar; hidden users: name only,
  non-clickable; nestedForward degrades to "forwarded from (hidden)" (reuse
  the official forward header component)
- Acceptance: visual walkthrough of fixture batches

**Commit 17 — `feat(web): read-only share-view trimming`**

- Hide the composer, disable write interactions, no left column/settings;
  follow themeParams inside the Mini App; keep patches minimal
- Acceptance: desktop/mobile viewports, read-only browsing without errors

**Commit 18 — `test(web): message-type coverage matrix + visual regression`**

- One fixture batch per type + Playwright screenshot baselines: text/
  entities/photo/album/video/file/sticker/voice/round video/poll/location/
  contact/reply/four forward states/nested forward/unhosted placeholder/
  service messages
- This matrix is the compatibility regression gate after every upstream sync
- Acceptance: CI screenshot diff passes

### Phase 5 — Mini App and operations

**Commit 19 — `feat(web): Mini App integration`**

- telegram-web-app.js: ready()/expand(), read tgWebAppStartParam to locate
  the share; BotFather direct-link app configured
- Acceptance: tapping the direct link inside Telegram opens the share
  fullscreen

**Commit 20 — `feat(ops): production deployment`**

- Source build supervised by systemd, with the existing host
  reverse proxy owning public ports and TLS.
- Share HTML and reverse-proxy responses declare `noindex, nofollow`; crawlers
  remain allowed to fetch pages so they can observe the indexing directive.
- Document environment, health checks, upgrades, backups and rollback.
- Acceptance: a clean machine runs the whole flow without
  exposing the application server directly.

**Commit 21 — `docs: upstream sync procedure and license`**

- docs/UPSTREAM.md: two upstream lines — (a) telegram-tt fork: small commits
  stacked on upstream master, periodic rebase, keep official render code on
  conflicts and re-apply only our injection points, run the Commit 18
  regression matrix after each sync; (b) teleproto: pinned minor, monthly
  upgrades, alert-driven via `Unknown constructor` logs, contingency
  self-publish via official api.tl + `generate:tl`
- LICENSE GPL-3.0; complete README (privacy notice and known limitations)

### Phase 6 — Share-view interaction hardening

**Commit 22 — `fix(web): enforce share-view interaction policy`**

- Define an explicit Share View allowlist: scrolling, text selection/copy,
  media playback/viewing/download, safe external links, the generated
  unhosted-media Telegram button, and same-share reply positioning.
- The action dispatcher denies every other command while Share View is active;
  component entry points also remove search, keyboard shortcuts, profile/chat
  navigation, reactions, polls, message actions, and bot callbacks.
- Acceptance: avatars, sender labels, keyboard shortcuts, ESC, reactions,
  polls, inline callbacks, and internal navigation cannot change Share View
  state; permitted media, copy, download, external-link, and reply actions
  still work.

**Commit 23 — `test(web): cover share-view interaction policy`**

- Add desktop and mobile Playwright scenarios for the denied and allowed
  behaviors above, asserting URL and active message list stability after each
  denied action.
- Acceptance: the interaction matrix passes alongside the existing visual
  regression suite.

## 5. Maintainability design (hard constraints)

1. **Physical separation**: injection code lives in `apps/web/src/api/share/`
   - `packages/tlbridge/`; changes to official files are small,
     semantically-independent commits — rebase-friendly
2. **Layer alignment**: the hydrator follows the fork's `AllTLObjects`; the
   backend teleproto layer just needs to be ≥ the frontend layer (the backend
   serializes, the frontend hydrates against its own constructor table,
   unknown ones degrade); each upstream line has its own upgrade procedure in
   UPSTREAM.md
3. **Regression gate**: the type coverage matrix + screenshot baselines run
   after every upstream sync
4. **Sanitization lives in exactly one place (tlbridge)**; raw data never
   leaves the server
5. **Share dependency closure**: `tlbridge` owns the schema-aware peer-id
   field registry used by both dependency collection and sanitization. The
   public payload contains every referenced peer but never the forwarding
   account identity or a real peer id.
6. **Offline presentation dependencies**: Share View initializes both the
   WebA fallback pack and a generated legacy-key compatibility pack. Account-
   scoped visual catalogs use deterministic local presentation assets rather
   than attempting authenticated Telegram requests from a public viewer.

## 6. Risks and open questions

- **No precedent**: nobody has been found reusing WebA offline to render
  external messages; the PoC (Commits 12–14) is the first gate; the fallback
  is extracting the official bubble CSS into a light self-built renderer
- **teleproto abandonment** (tail risk): layer 228 already leads WebA; the
  contingency is self-publishing from the official api.tl with its bundled
  generator (§2.2)
- **Unknown constructors drop updates**: when a new type ships before the
  library updates, individual messages are silently dropped (logged,
  repairable via getDifference); alerting drives upgrades
- **Bot PM flood limits**: replies and fallback delivery during peaks need
  queueing
- The nested-forward heuristic is just that (strictly-earlier; same-second
  never counts); avatar resolvability is limited (unavailable for channels
  the bot is not in); message text being public is the product's intent and
  must be signposted

## 7. Overall acceptance standard

Forward ≥20 mixed-type messages from a real phone → a link within seconds →
1:1 reproduction in both browser and Mini App → hosted media plays (large
videos stream), the unhosted-media button delivers the file via bot PM →
nested forwards degrade as designed and same-second neighbours are not
misjudged → no accessHash/fileReference/real-id leakage on the public page
(automated assertions) → /delete yields 404.

## 8. Rejected alternatives (for the record, not on the main line)

- **grammY + cloud Bot API**: simplest deployment, but Bot API JSON→TL needs
  a hand-written full semantic mapper (violates the "zero-conversion
  passthrough" goal) and >20MB files can only use the fallback button. If the
  teleproto ecosystem risk ever materializes we can switch: tlbridge gains
  one mapping layer, storage/API/web are all reused.
- **TDLib (tdl)**: td_json cannot yield raw TL (private td_api schema);
  conversion is unavoidable AND a native library comes along — rejected.
- **WebK**: ten-thousand-line single files + SolidJS migration +
  Service-Worker coupling; expensive to track upstream — rejected.
- **Running WebA's embedded gramjs as the backend**: coupled to WebA app code
  (util imports, browser WebSocket wrappers); far costlier to maintain than
  teleproto — rejected.
