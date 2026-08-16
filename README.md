# telegram-batch-forwarding-bot

Forward multiple messages to the bot and get a publicly shareable web page
(also a Telegram Mini App) that reproduces the batch as faithfully as
possible using the official Telegram WebA (telegram-tt) rendering pipeline —
the equivalent of QQ/WeChat "batch forward chat history".

## Architecture

```
User forwards N messages → teleproto (bot session, direct MTProto)
  → batching → raw TL JSON into SQLite + media hosted on disk
  → reply with share link / Mini App direct link
Browser/Mini App → telegram-tt fork (mocked)
  → TL JSON hydrated back into GramJs instances → buildApiMessage
  → official rendering pipeline
```

- `apps/bot` — teleproto bot: MTProto login, updates, batching, media
  download, share creation, oversized-file fallback delivery
- `apps/server` — HTTP: share data API (sanitized TL JSON) + media streaming
  endpoint + serves the web build
- `apps/web` — telegram-tt fork (git submodule, `share-view` branch tracking
  upstream)
- `packages/tlbridge` — TL JSON serialize/hydrate, sanitizer, forward
  heuristic (shared between frontend and backend)

Full design decisions, risks and the step-by-step plan live in
[docs/PLAN.md](docs/PLAN.md) (the authoritative reference).

## Prerequisites

- Node.js ≥ 22, pnpm 10
- `api_id` / `api_hash` from my.telegram.org → API development tools
- A bot created via BotFather (`BOT_TOKEN`); Mini App (direct link) short
  name configured in BotFather

## Development

```bash
cp .env.example .env   # fill in credentials
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Building the web app (apps/web)

`apps/web` is a git submodule pointing at our telegram-tt fork
(`agoudbg/telegram-tt`, branch `share-view`). It uses npm (not pnpm) and
requires Node ^24.11 / npm ^11 — newer than the rest of the repo:

```bash
git submodule update --init apps/web
cd apps/web
npm ci
npm run build:share   # production share-view build → dist/
npm run dev:mocked    # dev server on :1235, share view at /s/<shareId>
```

## Running the bot

```bash
pnpm --filter @tbfb/bot build
pnpm --filter @tbfb/bot start   # reads .env from the current directory
```

On first login the bot prints a `SESSION=…` line; copy it into `.env` to
persist the MTProto StringSession. Runtime data (SQLite, media, logs) lives
under `DATA_DIR` (default `./data`).

### Telegram test servers

Set `TELEGRAM_TEST_SERVER=1` to connect to the Telegram test DCs — useful
for Mini App development (test DCs allow plain-HTTP origins, so
`PUBLIC_ORIGIN` can be `http://localhost:3000`). The test environment is
fully separate from production: create a dedicated bot with the
test-environment BotFather, and keep `SESSION` and `DATA_DIR` separate as
well.

## Privacy notice

Share pages are public by default: the link is the permission. Message
contents and origin names are visible to anyone holding the link. Do not
forward batches containing sensitive content; `/delete` revokes a share at
any time.

## License

GPL-3.0 (the web app forks telegram-tt, GPL-3.0-or-later).
