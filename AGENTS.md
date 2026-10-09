# Working on simple-tds

A traffic distribution system: one Go server with an embedded React panel,
Postgres for configuration, ClickHouse for clicks and conversions, and a
sandboxed php-fpm container for PHP whitepages. User-facing behaviour is
described in [README.md](README.md).

## Run and test — do not rebuild the Docker image for ordinary changes

```bash
go run ./dev                          # deps in Docker, server from source, restarts on .go changes (~1 s)
cd web && npm install && npm run dev  # panel with hot reload at http://localhost:5173
```

| | |
|---|---|
| Panel (built into the binary) | http://127.0.0.1:18080 |
| Traffic port | http://127.0.0.1:18081 — pick the domain with a `Host:` header |
| Login | `admin` / `dev-password-123` — on a fresh database create it first (setup page, or `POST /api/setup`) |
| Settings | `dev/env` (shell variables override it) |
| Data | `.dev/` and the `simple-tds-dev` Docker volumes |

- Backend change: let the dev runner restart, then exercise it with `curl`
  against the panel API (`/api/...`, cookie session, send `X-TDS: 1` on every
  non-GET) and the traffic port.
- UI change: check it in the browser at `:5173` against the dev server, not
  against a mock.
- Before committing: `go build ./... && go vet ./... && go test ./...`, and
  `npm run build` in `web/` if the UI changed (it type-checks and checks the
  translations).
- Build the real image (`docker compose up -d --build`) only when the change
  touches packaging: `Dockerfile`, `docker-compose.yml`, `deploy/`, file
  permissions, or listeners. The production container runs as a non-root user
  on fresh volumes; test that case on a fresh compose project.
- To see geo-dependent behaviour locally, give a test domain Real IP
  `X-Forwarded-For`, add `127.0.0.1` to Settings → Trusted proxies, and send
  `X-Forwarded-For: <public ip>`.
- If the dev ports stay busy after a crash, find the process by port
  (`netstat -ano` / `lsof -i`) and stop that PID.

## Layout

| Path | What lives there |
|---|---|
| `cmd/tds` | entry point, env config, CLI rescue commands |
| `internal/model` | entities and settings shared by every layer |
| `internal/store` | Postgres: schema, migrations, generic CRUD over `db`-tagged structs |
| `internal/events` | ClickHouse: batched click writer, conversions, report queries |
| `internal/engine` | the click path: snapshot, filters, stream choice, actions, postbacks |
| `internal/antibot` | IP lists, UA signatures, header/TLS checks, JS challenge |
| `internal/geo`, `internal/extapi` | MMDB lookups; external HTTP JSON providers |
| `internal/whitepage` | whitepage storage, static serving, FastCGI client |
| `internal/web` | listeners, TLS/ACME, public routes, panel API, embedded UI |
| `web/` | panel sources (React + TypeScript + Vite) → built into `internal/web/ui/dist` |
| `web/src/i18n` | panel translations: `t()` helpers, `ru.json` (UI text), `ru.server.json` (text sent by the server) |
| `dev/` | development runner and its compose file |
| `deploy/` | PHP sandbox image and ClickHouse config |

## Rules that are easy to break

- **The click path never touches a database.** It reads an immutable snapshot
  (`engine.Snapshot`) swapped atomically by `Engine.Reload`. Any API handler
  that changes configuration must end with `s.reload(ctx)`. Clicks are queued
  and written to ClickHouse in background batches.
- **Authorization is in the API layer, and runtime repeats it.** Rows belong
  to their creator (`model.Owned`); `mount` in `internal/web/api_config.go`
  enforces ownership by default. Campaign access goes through
  `s.campaign(ctx, id, minAccess)`. A campaign is reached by a direct share or
  by a share on its group (`campaign_groups`; the higher level counts): both
  come out of `Store.UserShares`, so go through `s.shareMap` rather than the
  tables. A group only ever holds its owner's campaigns, and only the owner
  moves a campaign between groups (`checkCampaignGroup`). Something a user may
  not see answers 404, not 403. Report queries must pass through `s.scope`. At runtime a campaign
  only answers on domains, and converts through postback keys, of users who
  run it (`CampaignRT.UsableBy`). Any new endpoint or entity needs the same
  treatment.
- **Schema changes are additive and idempotent.** Postgres: append to
  `migrations` in `internal/store/store.go`. ClickHouse: append to
  `chMigrations` in `internal/events/events.go`. Both run on every start;
  existing installs must upgrade in place with no manual step.
- **New stream action:** `RegisterAction` in `internal/engine/actions.go` with
  its fields; the panel builds the form from that. **New filter:** add a
  `FilterDef` in `internal/engine/filters.go`. Neither needs UI code.
- **URLs supplied by users are untrusted.** Server-side fetches on behalf of
  non-admins must use a dialer that refuses private addresses (see
  `publicOnly` in `internal/engine/remote.go`).
- **Uploaded PHP runs only in the sandbox container**, never in the server
  process. Paths sent to it go through `Manager.PHPDir`.
- **The panel is served under a variable prefix** (`/` on ip:port,
  `/<admin path>/` on domains): UI URLs are relative, routing uses the hash,
  API calls go to `api/...` without a leading slash.
- **Partial updates:** `PUT` decodes over the stored row (`readPatch`); maps,
  lists and pointers present in the body replace the old value, so the stored
  row stays intact for "did this field change" checks.
- **Dashboards are personal** (`internal/web/api_dash.go`): a row is visible
  to its owner only, admins included, and holds no data — widgets read the
  reports, which apply the usual scope.
- `internal/web/ui/dist` is build output and is not committed.

## Translations

The panel is in English (the default) and Russian; the switch is in the
sidebar footer and on the login page. English is the source and lives in the
code — the English text is the dictionary key. **Every change that adds or
rewords text a user can see must update the Russian dictionaries in the same
commit**; a feature is not done while part of it is English-only.

- UI text goes through the helpers in `web/src/i18n/index.ts`: `t('Save')`,
  `t('Delete {name}?', { name })`, `tn(n, '{n} stream', '{n} streams')` for
  plurals (Russian needs three forms), `tx('Read <a>the docs</a>', {...})` for
  sentences with markup. The first argument is always a string literal. Keep a
  sentence in one key; do not glue translated fragments together.
- Add the translation to `web/src/i18n/ru.json`. `npm run i18n` (also the
  first step of `npm run build`) fails on a missing or unused key, on a lost
  `{placeholder}`, and on English written straight into JSX.
  `node scripts/i18n-check.mjs --fix` adds empty entries for new keys and drops
  unused ones.
- Text that reaches the panel from Go — `Label`/`Description`/`Help` of
  actions, action fields and filters, built-in preset names, messages passed
  to `bad(...)`/`conflict(...)` and other errors shown to the user, domain
  check statuses, simulator notes — is displayed through `ts()` and translated
  in `web/src/i18n/ru.server.json`. Add an entry whenever you add or change
  such a string; `{1}`, `{2}` stand for the variable parts of a message
  (`"stage \"{1}\": the name is too long"`). `go test ./internal/web` checks
  the action, filter and preset texts; error messages are not checked
  automatically, so grep for the ones you touched.
- Values shown through `humanize()` (conversion types, bot reasons, click
  actions) are looked up in `ru.server.json` by their humanized form
  (`no_stream` → `"No stream"`).
- Russian wording follows the terms already in the dictionary: кампания,
  поток, вайтпейдж, клик, конверсия, постбэк, этап, цель, пресет, Антибот.
  Do not translate names stored by users, values sent to the API, macros, or
  CSV export headers.
- To add a language: add it to `LANGS` and the dictionaries map in
  `web/src/i18n/index.ts` and give it its own pair of JSON files.

## Conventions

- Go: standard library first; errors returned to the API as
  `{"error": "..."}` via `bad(...)` / `conflict(...)`; comments explain why,
  not what.
- UI: no UI kit; shared pieces are in `web/src/components`, design tokens in
  `web/src/styles.css`. Read access level and role from the helpers in
  `web/src/hooks.ts` and never call admin-only endpoints as a regular user.
- Commit messages: imperative subject, a body that says what changed for the
  user. Do not commit `.env`, `.dev/` or build output.
- Several sessions may work in this tree at once. Before committing, check
  `git status` for changes you did not make and do not revert or publish them
  without asking.
