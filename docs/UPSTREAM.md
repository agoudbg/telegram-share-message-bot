# Upstream Sync Procedure

This project tracks two independent upstream lines. Keep their upgrades
separate so a rendering regression can be attributed to telegram-tt and a TL
schema regression can be attributed to teleproto.

## telegram-tt Fork

`apps/web` is a submodule pointing to `agoudbg/telegram-tt` on the
`share-view` branch. Its `upstream` remote is
`https://github.com/Ajaxy/telegram-tt.git`.

The branch consists of small project commits stacked on upstream `master`.
Do not merge upstream into `share-view`; periodically rebase the stack:

```bash
git submodule update --init apps/web
cd apps/web
git status --short
git fetch upstream --prune
git switch share-view
git rebase upstream/master
```

The worktree must be clean before the rebase. If the `upstream` remote is
missing, restore it first:

```bash
git remote add upstream https://github.com/Ajaxy/telegram-tt.git
```

### Conflict Policy

Keep upstream's official render implementation when a conflict touches
message components, builders, media loading or localization. Then reapply
only the narrow share-view hook needed by the rebased project commit. Do not
copy an old upstream function wholesale to preserve a project patch.

Project-owned code is concentrated in:

- `src/api/share/`
- `src/components/share/`
- `src/bundles/share.ts`
- `tests/playwright/share-view.spec.ts` and its baselines

Expected glue in upstream files is limited to the mocked build/route,
share-data injection, hosted-media short circuit and read-only gates. The
main integration surfaces are:

- `index.html`, `vite.config.ts`, `src/components/App.tsx` and
  `src/util/moduleLoader.ts`
- `src/api/gramjs/apiBuilders/messages.ts` and `messageContent.ts`
- `src/util/mediaLoader.ts`
- `src/components/middle/` message/header/composer files
- localization fallback/types used by share-only visible text

Generated `dist/` output is ignored and must not be committed.

### Regression Gate

After resolving the rebase, rebuild and run the full compatibility matrix:

```bash
npm ci
npm run check:ts
npm test
npm run build:share
npm run test:playwright
```

Inspect both desktop and mobile screenshot diffs. Update baselines only when
the upstream visual change is intentional and the read-only behavior,
forward origins, unhosted placeholder and all message-type fixtures remain
correct.

Publish the rebased fork with lease protection, then record its new gitlink
in the main repository:

```bash
git push --force-with-lease origin share-view
cd ../..
git add apps/web
git commit -m "chore(web): sync telegram-tt upstream"
```

Run the root `pnpm build`, `pnpm test` and `pnpm lint` gates before merging
the gitlink update.

## teleproto

The backend pins a teleproto minor in `apps/bot/package.json` with a range
such as `~1.228.5`. The second version component is the Telegram TL layer;
keep the backend layer at least as new as the WebA constructor table.

Review releases monthly and immediately when the bot emits either
`Type ... not found` or `Unknown constructor`. Those lines are mirrored to
`DATA_DIR/logs/unknown-constructors.log`.

Routine upgrade:

```bash
pnpm --filter @tbfb/bot outdated teleproto
pnpm --filter @tbfb/bot update teleproto@~1.<layer>.<patch>
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

Review the package and lockfile diff. Then run a real test-environment bot
session that receives a message and media update before deploying the new
layer. Do not broaden the range to `^` without explicitly accepting automatic
TL layer changes.

### Maintainer Contingency

The published npm package contains generated TL output but not
`teleproto_generator/`. If teleproto stops publishing current layers, work
from a source checkout:

```bash
git clone https://github.com/sanyok12345/teleproto.git
cd teleproto
npm ci
# Replace teleproto_generator/static/api.tl with the current official schema.
npm run generate:tl
npm run build
npm run typecheck
npm run publish:check
npm run publish:prepare
npm pack ./dist
```

Install the resulting tarball in an isolated project copy and run the full
root test suite plus a Telegram test-server smoke test. Record the source
commit, schema source, TL layer and generated tarball checksum. Publish it to
the project's internal registry only after those checks, then pin
`apps/bot/package.json` to that internal build.
