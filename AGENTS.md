# Project Instructions

## Language boundary (highest priority; overrides the global rules for this repo)

- Code comments, commit messages (subject and body), repository documents
  (README, docs/), and test descriptions: **English only**.
- Keep in original form: identifiers, file paths, API/protocol field names,
  and other technical symbols.
- Conventional Commits type prefixes (`feat:`, `fix:`, `chore:`, …) stay in
  English as machine-parseable markers.
- `apps/web` is a fork of upstream telegram-tt: keep upstream code and its
  comments untouched (English as-is); code we add (e.g. `src/api/share/`)
  still follows the English-comment rule.
- Conversation with the user: Chinese.

## Authoritative design reference

`docs/PLAN.md` is the approved implementation plan. Align with it before
deviating; if a deviation is necessary, update the plan in the same change.
Each plan step lands as one independent commit.

## Build, test, lint

```bash
pnpm build      # all workspace packages (tsc)
pnpm test       # vitest across packages
pnpm lint       # eslint flat config at repo root
pnpm format     # prettier
```

## Dependency isolation

Do not run `pnpm install`/`pnpm add` in the active working tree unless the
user explicitly requested it for the task at hand. If verification requires
installing dependencies, use an isolated copy under `C:\tmp\codex-verify\...`
per the global instructions.
