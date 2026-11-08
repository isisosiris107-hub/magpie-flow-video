# magpie-flow-video

A local proxy that lets a model generate video on **Google Flow** with *your own account cookies*, and exposes **every Flow generation parameter** (4× variants, 10 s duration, resolution, aspect ratio, seed, frames, references, …).

One Node process (~90 MB), no browser in the running path:

```
magpie-image MCP  ──►  magpie gateway (:3425)  ──►  flow-video proxy (:8787)  ──►  node:http  ──►  flow.google.com
magpie-video MCP  ────────────────────────────────►  flow-video proxy (:8787)  ────────────────►  (same)
magpie plugin tools ──────────────────────────────►  flow-video proxy (:8787)  ────────────────►  (same)
```

The proxy speaks the OpenAI-shaped videos API that magpie's built-in `generate_video` already calls, is an MCP server over both streamable HTTP and stdio, and ships as an installable magpie plugin.

## Quick start

Requires Node.js 22+ and a Google account with access to `flow.google.com`.

```bash
magpie plugin add github:isisosiris107-hub/magpie-flow-video
magpie plugin list
```

Open **Google Flow** in magpie's sidebar and press **Sign in with Google**. A Chrome window opens for the sign-in and closes when it is done; no cookies are bundled with the plugin. [Install](#install-one-click) lists the terminal, MCP and HTTP alternatives, and [Running](#running) covers the proxy without magpie. `npm test` runs 18 checks against captured Flow payloads; `node server.mjs check` verifies a session without spending credits.

## What was reverse engineered

Flow no longer uses the old REST host `aisandbox-pa.googleapis.com` (returns 401 with browser cookies). It uses WizRPC `batchexecute`:

```
POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
     ?rpcids=<id>&source-path=/project/<id>&bl=<WIZ.cfb2h>&f.sid=<WIZ.FdrFJe>&hl=en&_reqid=<6 digits>&rt=c
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
x-same-domain: 1
f.req=[[["<rpcid>","<json payload>",null,"generic"]]]&at=<WIZ.SNlM0e>
```

`f.req` payloads are **sparse JSON arrays** — protobuf field N sits at array index N-1. Generation rpcids: `YhhmEf` (text), `eb1hJf` (first frame), `nprQif` (first+last), `MZZa6b` (references), `fZytfe` (extend), `p0UkFb` (upsample); `jwpduf` polls operations, `Zzl0ze` lists project media, `as29s` resolves signed `flow-content.google` URLs, `maseQ` uploads an image, `jHPbke` creates a project. Reads that matter here: `nzlxg` (credits), `HTrJv` (live model catalog), `o30O0e` (signed-in person).

Two things looked like they required a browser, but do not:

1. `WIZ_global_data` — including the `at` CSRF token, `cfb2h` (`bl`), `FdrFJe` (`f.sid`) and the reCAPTCHA site key — is in the HTML of a plain authenticated `GET https://flow.google.com/`.
2. A **single-use reCAPTCHA Enterprise token** can be minted over HTTP: load `enterprise.js` for its release `v`, GET the `anchor` page for its `recaptcha-token`, then POST `/recaptcha/enterprise/reload` with that token. The `sa` (action) parameter must be `VIDEO_GENERATION` on **both** the anchor URL and the reload form; otherwise Flow answers `PUBLIC_ERROR_UNUSUAL_ACTIVITY`. (Flow's page poisons `grecaptcha.enterprise.execute` with `action: "extension_hijack_detected"`, which is why extension-minted tokens fail.)

So `flowhttp.mjs` does the whole job with `node:http`/`node:https`: scoped Cookie headers, WIZ bootstrap, Set-Cookie rotation folded back into the jar, captcha mint, form POST, mp4 download. No paid captcha solver, no npm dependencies, no patched Go binary, and **no Chromium**. `node:http` rather than global `fetch` is deliberate: undici + llhttp-wasm add ~20 MB of RSS.

## Files

| File | Job |
|---|---|
| `flow.mjs` | Wire protocol: rpcids, sparse payloads, envelope parser, live `HTrJv` catalog parser, parameter normalisation (pure, no network) |
| `flowhttp.mjs` | The no-browser client: WIZ bootstrap, cookie jar, reCAPTCHA mint, batchexecute POST, mp4 download |
| `browser.mjs` | Cookie loaders (JSON / Firefox-family sqlite) + the headed sign-in window |
| `server.mjs` | HTTP proxy + HTTP/stdio MCP + `check` / `login` / `accounts` / `models` CLI |
| `config.mjs` | Paths, ports, env overrides; finds browsers and cookie DBs on Linux, macOS and Windows |
| `accounts.mjs` | Cookie-jar registry, JSONL credit ledger |
| `schema.mjs` | One tool schema shared by the MCP server and the plugin |
| `signin.mjs` | The one sign-in flow: headed window, session check, settle cookies, register the account |
| `index.mjs` | magpie plugin entry: `tool` hooks, proxy sidecar, page sign-in requests |
| `setup.mjs` | Wiring for a *non-plugin* install (magpie + `~/.pi/agent/mcp.json`); the plugin does this itself |
| `fixtures/` | Real live `HTrJv` catalog responses (`HTrJv.json`, `HTrJv-1.2.json`), used by the tests |
| `page/` | The **Google Flow** page in magpie's sidebar and its Usage panel |
| `test.mjs` | 18 golden tests against captured Flow payloads |

For a **non-plugin install**, run `node setup.mjs`: it wires `magpie-video` into `~/.pi/agent/mcp.json`, adds the `flow-video` provider to `~/.config/magpie/providers.json` with `balanceURL` / `balanceMethod` / `balancePath` for the Usage page, and sets `modelKinds` in `~/.config/magpie/settings.json`. It is idempotent and writes one `*.bak-flow-video` backup per file. Then start the proxy with `npm run serve`.

Verified end to end with a signed-in session jar: text-to-video through the magpie gateway, the streamable-HTTP MCP tools and the plugin tools, including credit accounting and the live `/v1/models` catalog (family names, wire keys and real credit prices read from Flow, not hardcoded). See [Caveats](#caveats) for exactly what was and was not spent on a live generation. `npm test` passes 18 checks.

## Cookies

`config.mjs` prefers a full session jar at `~/.local/share/flow-video/cookies.json` (from `npm run login`), then the newest `~/.waterfox/*/cookies.sqlite`, then AI Studio Playwright `storage-state.json` files. Waterfox sqlite is copied to a temp file so a running browser never blocks the read, and only unexpired, unpartitioned Google cookies are imported.

```bash
node server.mjs check   # shows cookiesFile, at/bl/sid, captcha mint, a read-only RPC
```

`check` should show `"at": true`, `"transport": "http"` and a `credits` reply. It never generates anything and spends no credits.

**If a jar expires**, sign in at `https://flow.google.com/` in Waterfox (no export needed), or run `npm run login`. A jar that is not signed in shows `at: false`, the marketing `/about` page and 401 on every batchexecute — that is a session problem, never a renamed token. Google rotates `SIDCC` / `__Secure-1PSIDTS` on each response; `flowhttp.mjs` folds every `Set-Cookie` back into the jar immediately (no throttle), so a restart does not need a new sign-in.

`npm run login` opens a short-lived headed Chrome window straight at Google's sign-in page and saves `~/.local/share/flow-video/cookies.json`. `npm run login -- <id>` does the same for a **new account** (`cookies-<id>.json` plus an entry in `accounts.json`). It only declares success when the page is back on `flow.google.com`, `SNlM0e` is present *and* a read-only batchexecute returns 200 — Google's sign-in UI also has an `SNlM0e` token, so that alone would be a false positive. It settles with three read RPCs before saving, then **closes Chrome**; nothing stays open. A saved jar without `SID`/`SAPISID` is ignored. The Chrome window needs a graphical display.

Overrides: `FLOW_COOKIES=waterfox` forces the newest Waterfox profile, `FLOW_COOKIES=/path/to/file` uses a Playwright `storageState` (`{cookies:[…]}`) or bare array.

> `npm run login` uses its own fresh Chrome profile and deliberately injects **no** cookies — the `0/0 cookies` line is expected. `serve`/`mcp` read the saved jar.

## Running

```bash
npm run serve        # HTTP proxy + HTTP MCP on :8787 (the plugin does this automatically)
node server.mjs mcp  # same proxy plus a stdio MCP server, for old MCP clients
node server.mjs check    # session diagnostics (+ credits)
node server.mjs accounts # list every cookie jar and the default
node server.mjs models   # refetch and print the live model catalog
node server.mjs login    # interactive cookie refresh
node server.mjs login work   # add a SECOND account under the id "work"
npm test                    # wire-format + MCP handshake tests (18 checks)
```

If both are started, the second one reuses the already-running proxy (EADDRINUSE is handled). Prefer a single always-on `npm run serve`. Restart magpie if you edit `providers.json` by hand.

## Every parameter (`magpie-video` → `generate_video`)

| Field | Values | Notes |
|---|---|---|
| `prompt` | string | required |
| `negative_prompt` | string | appended to the prompt (Flow has no wire-level negative prompt) |
| `mode` | `auto`, `text`, `first_frame`, `first_last`, `references`, `extend`, `upsample` | inferred from the inputs you supply |
| `model` | a family name, an exact Flow wire key, or omitted | `omni-flash-1-2`, `omni-flash-1-1`, `veo-3-1-fast`, `veo-3-1-quality`, `veo_3_1_t2v`, `macaron_cookie_t2v_10s`. See *Model catalog* below |
| `duration` / `seconds` | `3`…`15` | every integer length with Omni 1.2 Flash (`macaron_cookie`); the default Omni 1.1 Flash has `4`, `6`, `8`, `10` |
| `output_count` / `n` / `variants` | `1`…`4` | **4×**: the request item is repeated four times with distinct seeds |
| `aspect_ratio` / `size` | `16:9`, `9:16`, `1:1`, `landscape`, `portrait`, `square`, `1280x720` | video wire codes: landscape 2, portrait 1, square 0 |
| `resolution` | `360p`, `720p`, `1080p`, `4K` | 360p is inline (`_360p` model + slot); 1080p/4K are upsample models |
| `start_frame` / `image` / `input_reference` | URL, `data:` URL, or local path | → `maseQ` upload then first-frame model |
| `end_frame` / `last_frame` | same | enables first+last mode |
| `reference_images` / `references` | array of the above (1–3) | enables ingredients/R2V mode |
| `video_media_id` / `video` | Flow media id | for `extend` and `upsample` |
| `seed` | number | deterministic UUIDs per variant (otherwise random) |
| `audio_pref` / `audio` | `0` silent, `1` audio (default), `2` | last element of the request wrapper |
| `project_id`, `project_title` | string | otherwise one project is created and cached |
| `captcha_action` | `VIDEO_GENERATION` (default), `IMAGE_GENERATION` | |
| `path` | directory or `.mp4` path | where to save the mp4s (default `outputs/`) |
| `wait_seconds` | `0`…`45`, default `20` | `0` returns the job id immediately. Capped below the 60s MCP client timeout; call `generation_result` again for longer jobs |
| `account` | id from `list_accounts` | omit for the default account |

`generation_result({id, path, wait_seconds})` polls the job; `list_models({refresh, account})` returns the full live catalog; `session_status({account})` reports the WIZ/transport state read-only; `list_accounts()` lists cookie jars; `credit_usage({account, all, limit})` shows live balances and the spend ledger.

## Model catalog (new families appear after a refetch)

`HTrJv` is Flow's own captcha-free model-catalog read. It returns whatever families and wire keys Flow currently offers, each with per-tier prices, duration, mode and resolution. Nothing is hardcoded: **Omni 1.2 Flash** (`omni-flash-1-2` / `macaron_cookie`, 112 keys) appeared on its own when Flow released it, and an exact wire key works even before any code change.

Omni 1.2 Flash adds lengths `3`…`15` seconds for text, first-frame, first+last-frame and reference modes, at both 360p and 720p. Pass `model: "omni-flash-1-2"` (or an exact key such as `macaron_cookie_t2v_10s`) plus `duration`. Omitting `model` keeps the cheaper Omni 1.1 Flash default, which only has 4/6/8/10 s keys. On a tier-1 account the 11–15 s keys have no price, so the resolver picks the nearest usable length (10 s) rather than asking Flow for a key it will deny; `seconds` in the job is always the rendered length.

```bash
curl -X POST localhost:8787/v1/models/refresh   # refetch HTrJv, no credits spent
curl -s 'localhost:8787/v1/models?detail=1'      # families, keys, prices, tier, availability
magpie provider refresh flow-video               # magpie re-reads /v1/models
```

The provider has `refreshEvery: "6h"` and the proxy warms its own catalog every 30 minutes, so new families normally show up on their own. `list_models({refresh: true})` forces it immediately. magpie caches its fetched list in `~/.cache/magpie/models/flow-video.json`; run the refresh command after a forced refetch if you need it right away.

`nzlxg` also reports the account's `service_tier`. A model whose tier-1 price slot is **empty** is not available to that account (Flow answers `PUBLIC_ERROR_MODEL_ACCESS_DENIED`). `list_models` reports `available` per family, and family selection picks a key the tier can actually use — asking `veo-3-1-lite` for a 4 s clip on tier 1 resolves to `veo_3_1_t2v_lite` (8 s) rather than the denied `_4s` key. `seconds` in the job is then the model's real duration.

## Install (one click)

The repository *is* the plugin: `package.json` names `index.mjs` as `main`, so
there is nothing to build and nothing to install by hand. Magpie loads it with
its own Bun, adds the `flow-video` provider, and serves a **Google Flow** page in
its sidebar plus a panel on its Usage page.

**From magpie's window:** Plugins → Install → paste the repository URL
(`https://github.com/isisosiris107-hub/magpie-flow-video`) → Install.

**From a terminal:**

```bash
magpie plugin add github:isisosiris107-hub/magpie-flow-video   # or: magpie plugin add /path/to/this/folder
magpie plugin list                                            # → Google Flow, its tools, page and panel
```

**Then sign in, from the page.** Open **Google Flow** in magpie's sidebar, type a
name for the account and press **Sign in with Google**. A normal Chrome window
opens on Google's sign-in form; sign in with the account that has Flow access
and let it return to `flow.google.com`. The window closes itself and the account
is registered. Nothing is read from a browser you did not open, and no cookie is
ever bundled with the plugin.

The same sign-in is available three other ways, so a headless or agent-only setup
works too:

| Where | How |
| --- | --- |
| MCP tool | `sign_in` (opens the window, returns an id) then `sign_in_status` |
| HTTP | `POST /v1/login {"label":"work"}` → `GET /v1/login/{id}`; `GET /v1/login` lists availability |
| Terminal | `npm run login -- work` (or plain `npm run login`) |

Only one sign-in window is open at a time; a second request is refused with the
running one's id, so a double click cannot stack Chrome windows.

What the page and panel may read is limited by magpie itself: a plugin page is
sandboxed (`connect-src 'none'`) and gets only the reads its `package.json`
declares (`usage:summary`, `providers:list`). Credits live behind the proxy, so
the panel shows how much Flow traffic went through magpie and points at the
provider's balance card on the same Usage page, which reads the proxy's
`/v1/balance` (that is where the live credit balance appears).

### What the plugin does on load

- spawns `node server.mjs serve` detached on `127.0.0.1:8787` (one process, one
  HTTP proxy; look for Node in `FLOW_VIDEO_NODE`,
  `~/.local/share/pi-node/current/bin/node`, `/usr/bin/node`, `PATH`, then the
  host runtime), and reuses a proxy that is already listening;
- idempotently adds the `flow-video` provider and its `modelKinds` entry, because
  there is no plugin hook for `balanceURL` / `balancePath` / `modelKinds`. A
  `config` hook is deliberately **not** used: it would create a second provider
  also called `flow-video` and collide;
- registers eight tools: `flow-video_generate_video`, `_generation_result`,
  `_list_models`, `_session_status`, `_list_accounts`, `_credit_usage`, plus
  `_sign_in` and `_sign_in_status`. `generate_video` returns a job id at once
  because magpie's `plugin.RunTool` has a 55 s deadline; poll
  `_generation_result`.

Nothing about a particular account is bundled: a fresh install starts with no
cookies and asks for a sign-in. Cookies a user already has in Firefox, Waterfox,
Zen or a saved jar are found automatically (see [Cookies](#cookies)).

### Examples

4 variants, 10 seconds, 16:9, 360p, fixed seed:

```json
{"name":"generate_video","arguments":{
  "prompt":"a paper kite over a stormy sea, cinematic",
  "output_count":4,"duration":10,"aspect_ratio":"16:9","resolution":"360p","seed":42,
  "path":"outputs/kite.mp4","wait_seconds":0
}}
```

Image-to-video through the **existing `magpie-image` MCP** (its fixed schema only offers `prompt`, `seconds`, `size`, `image`, `reference_images`; use `magpie-video` for the rest):

```json
{"name":"generate_video","arguments":{
  "prompt":"slow dolly forward","seconds":"6","size":"16:9",
  "image":"./frame.png"
}}
```

## Credits and spend

Flow's own balance RPC is `nzlxg`, a captcha-free read with an empty payload. Its reply is `[total, serviceTier, sku, userPaygateTier, null, subscriptionCredits, [refreshSeconds, nanos]]`. We never guess a price: right before a generation we read the balance, read it again when the job settles, and record `max(0, before - after)` in `~/.local/share/flow-video/usage.jsonl`. That matters because Flow has 0-credit models and daily free-credit refreshes, so a hardcoded price table would be wrong.

```bash
curl -s localhost:8787/v1/credits            # live balance of the default account
curl -s localhost:8787/v1/credits?all=1      # every signed-in jar (others are skipped)
curl -s localhost:8787/v1/credits?all=1\&probe=1  # include cold jars too
curl -s localhost:8787/v1/usage?limit=20     # ledger + totals by account / model / day
curl -s localhost:8787/v1/balance            # the compact shape magpie's Usage page reads
```

`GET /v1/balance` is cheap: cached balances plus the ledger, no network on every refresh. The first cold read asks the default account once. `GET /v1/credits?all=1` skips jars without a signed-in session unless `?probe=1`; use `?account=<id>` to force one.

**magpie's Usage page** shows a `Google Flow` card (with its own icon) because the provider got a placeholder `key` (magpie only asks keys with a balance), `balanceURL: http://127.0.0.1:8787/v1/balance`, `balanceMethod: GET` and four labeled `balancePath` parts: `Balance: credits_text; Used today: today_text; Used total: total_text; Accounts: accounts_text`. Each value is a plain string — numeric fields are formatted with two decimals — and several parts are drawn as aligned label/value rows instead of one wrapped paragraph. `balanceParts` also turns off magpie's empty "Balance over time" sparkline. Magpie caches a card for a minute; the card's refresh button reads it again. It cannot absorb our per-generation credit numbers into its own `/api/usage` aggregates — that endpoint's ingest allowlist rejects `credits` and treats `cost` as USD — so the card is the supported way in.

## Multiple accounts

`~/.local/share/flow-video/accounts.json` is the registry:

```json
{ "default": "saved", "accounts": [
  { "id": "saved", "label": "Saved Flow login", "cookiesFile": "…/cookies.json" },
  { "id": "work",  "label": "Flow login work",  "cookiesFile": "…/cookies-work.json" }
]}
```

On first run it is auto-filled from the saved jar, every Waterfox/Firefox `cookies.sqlite`, every AI Studio `storage-state.json`, and `FLOW_COOKIES`. Edit it by hand or add one with `node server.mjs login work`. Each account gets its own `FlowClient` (its own cookie jar and WIZ tokens) and its own cached Flow project (`project.json` → `{projects: {accountId: projectId}}`), so sessions never mix. `node server.mjs check <id>` / `GET /v1/session?account=<id>` diagnose one account. Stale jars simply report `signed_in: false`.

Jars whose session is no longer accepted by Flow answer 401 on `nzlxg`; they are reported as unsigned-in rather than removed from the registry. A generation on an unsigned-in jar fails immediately with no credits spent. The proxy also reads `o30O0e` (the signed-in person's numeric gaia id) so two jars signed into the **same** Google account are counted as one credit pool: `credits` sums distinct people, while `windows` counts sessions. Sign each jar into a different Google account to get separate balances.

## Two accounts, one Google identity

`GET /v1/accounts` and `GET /v1/credits?all=1` print the Google email each jar is actually signed into. By default jars reporting the same gaia id share one credit pool, so the balance is not double-counted. If the jars really are different accounts and the identity probe is wrong, start the proxy with `FLOW_SEPARATE_ACCOUNTS=1` to count every signed-in jar as its own pool:

```sh
FLOW_SEPARATE_ACCOUNTS=1 npm run serve
```

## RAM footprint

**One Node process, 59 MB cold / ~77–98 MB busy RSS / ~20–32 MB PSS, and zero Chrome processes.** That is the whole footprint; peak measured RSS stayed under the 100 MB budget after a full generation.

- All Flow traffic uses `node:http`/`node:https`, not global `fetch` (undici + llhttp-wasm add ~20 MB RSS). `test.mjs` asserts neither `server.mjs` nor `flowhttp.mjs` calls `fetch`.
- Started with `--expose-gc --max-old-space-size=64 --max-semi-space-size=1` and `UV_THREADPOOL_SIZE=1`; `npm run serve` and the plugin's spawn both set these. The heap cap only bounds growth — V8 commits pages on demand, so it does not raise idle RSS. `global.gc()` runs after each poll iteration and after each job settles, releasing the multi-MB project listing and the mp4 buffers.
- mp4 bytes are written to disk and dropped from the job map; `/v1/videos/{id}/content` reads them back from the file.
- MCP is streamable HTTP on `/mcp`, so one proxy serves every client. `wait_seconds` is capped at 45 s (clients time out at 60 s); long jobs are polled with `generation_result` again.
- `GET /v1/credits?all=1` probes only jars that look signed in (our own `cookies*.json` with `SID`+`SAPISID`); other jars are reported as `skipped` with no client created. `?probe=1` forces a full sweep.
- `GET /v1/health` reports `clients`, `jobs`, `transport` and `rss_mb`.
- The old design kept two ~700 MB Chromium trees alive (one per login window) because `at` and the rotating cookies lived in that exact browser. It also spawned a ~70 MB Node child for every stdio MCP client. Both are gone: `~/.pi/agent/mcp.json` now points at the streamable HTTP endpoint, and `npm run login` closes its Chrome window after saving the jar.

## Caveats

- **End-to-end generation is verified** for text-to-video with the default Omni 1.1 Flash model (4 s ×1, 10 s ×2), a different family (`veo-3-1-lite` → `veo_3_1_t2v_lite`, 7.93 s, 10 credits), and **Omni 1.2 Flash** (`macaron_cookie_t2v_3s` 3.03 s / 9 credits and `macaron_cookie_t2v_5s` 5 s / 15 credits) through the MCP tools and the pure-HTTP client. The 1.2 catalog is also unit-tested (112 keys, 3–15 s, `first_last` frames, tier-aware fallback). The polling reader was corrected against a live `Zzl0ze` listing — this build reports completion in the media detail (`detail[8] = [3]`), not in the `jwpduf` record's `status` field. A project that has collected too many clips stops answering `Zzl0ze` (error `[5]`), so the proxy health-checks the cached project before submitting and rotates to a fresh one. New clips are found by media-ID difference against that pre-submit snapshot, not by a wall-clock cutoff — Flow's row timestamps can trail the local clock by an hour. MCP `generate_video` + `generation_result` was verified end to end over streamable HTTP (4 s mp4, 7 credits). Image-to-video, extend, upsample, 1080p/4K and 3×/4× variants are wired but have not each been spent on a live generation.
- Flow is a private, undocumented API. It can change without notice; rpcids and sparse field positions come from the `boq_labs-ai-sandbox-frontend_20261105.10_p0` bundle and live captures. Using your own account cookies for automation may conflict with Google's terms of service; this plugin is a community project, not an official Google integration.
- `output_count` 1–4 comes from Flow's own JS; 2× was verified live (two distinct mp4s), 3×/4× extrapolate the same repeated-item mechanism. The 1080p/4K upsample mapping and square (`1:1`) wire code `0` come from a second reference implementation and are unverified. Some catalogue families are gated by the account's plan: tier-1 accounts cannot use Veo 3.1 Lite Low Priority or the upsamplers, and Flow returns `PUBLIC_ERROR_MODEL_ACCESS_DENIED`.
- reCAPTCHA tokens are single-use and rate-limited. Repeated generation probes in quick succession get `PUBLIC_ERROR_UNUSUAL_ACTIVITY`; back off and retry rather than assuming the code is broken.
- The proxy binds `127.0.0.1` only and has no authentication; anything on this machine can call it. It reads your Google cookie jar — treat `~/.local/share/flow-video/` as a secret.

## License

MIT — see [LICENSE](LICENSE).
