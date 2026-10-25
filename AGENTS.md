# AGENTS.md

Pazuzu: Nuxt 4 monitor for Strata inference engines. Scrapes Prometheus `/metrics` from several servers into SQLite; serves a live dashboard (WebSocket + polling fallback), metric history with rollups, a load heatmap, and i18n.

## Commands

- `npm run dev` — dev server on http://localhost:3333 (port set via `devServer.port` in `nuxt.config.ts`).
- The dev server is usually already running by the user on :3333 — check `http://localhost:3333` before starting another one; don't kill or restart it without being asked.
- `node test/parse.test.mjs`, `node test/auth.test.mjs`, `node test/config.test.mjs`, `node test/gateway.test.mjs` and `node test/client-access.test.mjs` — the entire test suite. Bare Node scripts, no test framework; they import `.ts` directly, so type-stripping-capable Node is required (README: Node ≥ 22.22 or ≥ 24.15; older Node 24 prints EBADENGINE).
- `npm run build && node .output/server/index.mjs` — production run. `npm run build` is the only whole-project validation: there is **no** lint, formatter, typecheck script, or CI. Match existing style (2 spaces, no semicolons, single quotes, `foo (args)` space before parens).
- Test fixtures are real `/metrics` captures in `test/fixtures/`.

## Architecture

- Nuxt 4 layout: frontend in `app/`, Nitro backend in `server/` (file-based API in `server/api/`, WS route `server/routes/_ws.ts`).
- Background loops are Nitro plugins (`server/plugins/scraper.ts`, `rollups.ts`) driving `server/utils/scheduler.ts`: self-rescheduling `setTimeout` that re-reads intervals from the DB every cycle, so settings changes apply without restart (`settings.put.ts` also calls `schedule*` directly).
- All process-wide server state lives on `globalThis.__pazuzu` via `server/utils/runtime.ts` so dev HMR doesn't duplicate timers or lose counter baselines. Add new background state there, never in module-local variables.
- SQLite via better-sqlite3 (synchronous API), file `data/data.db` (gitignored, auto-created; path from `db.path` in `config.json`, applied when the DB opens at startup). Schema is inline `CREATE ... IF NOT EXISTS` DDL in `server/utils/db.ts` — there is **no migration system**, so schema changes must be idempotent and existing dev DBs updated by hand.
- Storage tiers: `samples` (raw, ~10 s, 48 h) → `rollup_hourly` (400 d) → `rollup_daily` (forever). `/api/range` picks the tier itself from row counts; `server/utils/rollup.ts` is idempotent (recomputes last 3 h / 3 d) and also performs retention deletes.
- Frontend live state is one shared plugin (`app/plugins/live.ts`, accessed via `useLive()`); pages must not open their own WebSocket.
- Auth is opt-in via `config.json` (`server/utils/config.ts`, path overridable with `PAZUZU_CONFIG`; missing file = defaults; reloaded on mtime change). The only app-code writer is `saveConfig` (atomic tmp+rename, keeps unknown JSON keys, drops the mtime cache) behind `GET/PUT /api/config` (admin-only while auth is on) and the System configuration card on the Settings page; `db.path` still applies only at startup. `server/middleware/auth.ts` gates `/api/*` (public allowlist in `OPEN_AUTH_PATHS`; `/api/auth/password` requires a session) and `/_ws` checks the cookie in its own `open()` handler (WS upgrades bypass middleware). Frontend gate: `app/middleware/auth.global.ts` + `useAuth()`; SSR pages that fetch `/api` must forward cookies (`headers: useRequestHeaders(['cookie'])`).
- Users/sessions are SQLite tables (db.ts); passwords are scrypt hashes. Roles: `admin`/`user` — admins manage users at `/api/users*` and the `/users` page, and `PUT /api/settings` is admin-only while auth is on; `users.disabled` freezes an account (`verifySessionToken` kills the session), `users.gitlab` marks OAuth-created accounts, `servers.created_by` records the author — server edits go to creator-or-admin only (`canManageServer`, rules in `server/utils/permissions.ts`, reachable from bare Node). `server/utils/credentials.ts` holds the pure primitives (hash/token/cookie) and must not import other utils. Files reachable from bare Node (`credentials.ts`, `db.ts`, `config.ts`, `runtime.ts`, `permissions.ts` — imported by tests and `scripts/reset-password.mjs`) must use explicit `.ts` extensions in relative imports; extensionless imports break plain Node loading.

## Metrics

- `server/utils/metrics.ts` is the single catalog: every stored/displayed metric needs a `MetricDef` (label/unit/agg); heatmap selector lists are driven by `heatmap: true`.
- Raw `vllm:*` / `strata:*` series are stored verbatim; `derived:*` series are computed by the scraper (`server/utils/scrape.ts`) from counter deltas using `COUNTER_RATES` / `HIST_WINDOW_AVG` / `BUSY_PCT`. Define new derived metrics there, not in API routes or the frontend.
- Label sets are stored as `normalizeLabels()` strings (sorted `k=v`, comma-joined) — always normalize before keying or comparing.
- Scraping `/metrics` must send `Accept: text/plain`; Strata returns JSON otherwise.

## Gateway (/v1 load-balancing proxy)

- `server/routes/v1/[...].ts` is the catch-all; it bypasses the auth middleware (which only gates `/api/*`) and authenticates clients by `msk_…` bearer tokens — sha256 in the `gateway_clients` table, raw token shown once at create/rotate (`server/utils/gateway/tokens.ts`, hash reuses `hashToken` from credentials.ts; errors are OpenAI-shaped JSON).
- Pure, bare-Node-testable core in `server/utils/gateway/`: `types.ts` (ServerLoad + admissibility), `router.ts` (affinity → least-loaded), `queue.ts` (strict priority + aging 30 s/5 min, per-client round-robin), `session.ts` (`X-Session-Id` header → hash of the conversation opening → no key), `proxy.ts` (fetch forwarding, SSE `usage` sniffing). `state.ts` wires them to the DB and to `globalThis.__pazuzu` via `gatewayRuntime()` (inflight counters, queues, affinity cache, IP/usage aggregators); the 5 s maintenance loop is `server/plugins/gateway.ts`.
- Admission control is gateway-owned: the gateway's own inflight counter is authoritative (capacity: `servers.gateway_capacity` → `strata:live_slots` → `gateway.defaultCapacity`), and a server with scrape-reported `waiting > 0`, KV usage ≥ 95% or a recent live error (`ejectionS`) temporarily takes no new work — this keeps the upstream engine's own FIFO queue empty so the gateway priorities mean something.
- `gateway.enabled` in `config.json` is false by default and must stay that way; `servers.gateway_mode` (`on | drain | off`) and `gateway_capacity` are edited via PATCH `/api/servers/:id` and the Servers page; client CRUD + status live under `/api/gateway/*` (admin-only while auth is on) with the `/clients` page. Restarting Pazuzu drops in-memory queues (documented in README).
- Client ⇄ server access: `gateway_clients.servers_all` (1 = every server, the default) plus `gateway_client_servers` pairs; routing filters loads per client (`allowedServerIds`/`loadsForClient` in `gateway/state.ts`), and a queued task whose allowed engines are all saturated does not block lanes other clients could use. Both directions are edited from the UI: the Clients page (`serversAll`+`serverIds` on POST/PATCH) and the Servers page (`PUT /api/gateway/servers/:id/clients`, which flips an unchecked unrestricted client to an explicit selection of the other current servers).

## Version check & updates

- The version is the checkout's commit SHA (no tags, no `version` in package.json). `server/utils/update.ts` holds the pure parsing helpers (tested by `test/update.test.mjs` — keep its relative imports `.ts`-explicit) plus the `git ls-remote` check; state lives on `runtime().update` and the loop (first check 30 s after boot, then 6 h) is `server/plugins/update-check.ts`.
- Applying is manual-only, never automatic: `POST /api/update/apply` (admin while auth is on) spawns detached `scripts/autoupdate.mjs` (wait for exit → pull --ff-only → install → build → restart, console + result in `data/update.log`/`last-update.json`) and exits; disabled in dev mode. `update.sh|.bat` remain the offline/fresh-clone path.

## i18n

- Six locales in `i18n/locales/*.json`; `en.json` is canonical and all six are currently key-synced — add every new UI string to all six files. A new language = one JSON file + entry in `nuxt.config.ts` (strategy `no_prefix`, cookie `pazuzu_locale`).

## nuxt.config.ts — do not remove these nitro workarounds

- `externals.inline` of the Nuxt renderer: Windows-only workaround for nuxt/nuxt#36467; without it all SSR returns 500.
- `experimental.websocket: true`: required for the `/_ws` upgrade in dev and prod.
- `external: ['better-sqlite3']`: the native module must not be bundled.
- `ui.fonts: false`: no network font fetch at build time.

## Conventions

- Auth is off by default and must stay that way (trusted LAN service) — don't enable it in code/config defaults or force it on.
- README is English by default (`README.md`); translations are `docs/README.ru.md` and `docs/README.zh.md` — each starts with a language-switch line of relative links. Keep all three in sync when editing. User-facing docs are in Russian; code comments in English; commit messages are plain English imperatives (no conventional-commit prefixes).
- After any change that affects user-visible behavior, setup, ports, commands, or architecture, update `README.md` in the same task to keep it accurate.
