# Deploying wemo-assistant

Everything you need to take this from "runs on my PC" to "runs for the shop", written so you can
follow it again in six months without remembering any of it. Read the **mental model** first, then
do the three parts in order (backend → admin → mobile — the other two point at the backend, so it
has to exist first).

---

## Mental model (read this first)

Three pieces, three places:

| Piece | What it is | Where it runs in production | Talks to |
|---|---|---|---|
| **Backend** | Hono API + D1 database + R2 images | Cloudflare **Worker** (`*.workers.dev` URL) | — (source of truth) |
| **Admin web** | React app for ingesting/editing the catalog | Cloudflare **Pages** (static site + tiny proxy) | the backend |
| **Clerk mobile** | Offline Android app for lookups | An **APK** sideloaded onto the shop phone | the backend |

**Auth is two shared secret tokens** (no user accounts — this is a one-owner internal tool):

- **`ADMIN_TOKEN`** — grants **write** access. You paste it into the admin web's Settings. Every
  mutation route on the backend checks `Authorization: Bearer <ADMIN_TOKEN>`.
- **`CLERK_TOKEN`** — grants **read-only** access (`/sync`, `/chat`). You type it into the mobile
  app's Sync screen. The admin token is also accepted there, so the owner can use the clerk app too.

Both are just strings **you invent**. Generate them strong, set them once on the backend, and put the
matching value into each client. That is the entire login system.

**One-time vs. every-time:** creating the D1 database, the R2 bucket, and setting secrets are
**one-time**. After that, shipping a change is just `bun run deploy` (backend), re-upload `dist`
(admin), or rebuild the APK (mobile). The short version lives at the [bottom of this doc](#redeploying-later-the-short-version).

---

## 0. Prerequisites (one-time)

- A **Cloudflare account** (free tier is enough to start).
- **Bun** installed (backend/admin tooling) and, for mobile, **Flutter + Android SDK** (already on
  the main PC — see `apps/mobile/README.md`).
- Log wrangler into your Cloudflare account:

  ```bash
  cd apps/backend
  bunx wrangler login          # opens a browser, authorizes wrangler
  ```

- Invent your two tokens now and keep them somewhere safe (a password manager). Any long random
  string works. Quick ways to generate one:

  ```bash
  node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"   # any OS with node
  ```
  ```powershell
  # PowerShell alternative
  [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
  ```

---

## 1. Backend — Cloudflare Worker (deploy this first)

All commands run from `apps/backend`.

### 1a. Create the Cloudflare resources (one-time)

```bash
cd apps/backend
bun install

bunx wrangler d1 create wemo                       # creates the D1 database
bunx wrangler r2 bucket create wemo-catalog-images # creates the image bucket
```

`d1 create` prints a **`database_id`**. Open `apps/backend/wrangler.jsonc` and paste it over the
placeholder:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "wemo",
    "database_id": "PASTE_THE_ID_HERE",   // <- was PLACEHOLDER_RUN_wrangler_d1_create_wemo
    "migrations_dir": "drizzle"
  }
]
```

(The R2 binding is already named `wemo-catalog-images` in `wrangler.jsonc`, so no edit needed there.)

### 1b. Set the secrets (one-time, re-run only to change a value)

Secrets are stored encrypted on Cloudflare — **never** commit them. `wrangler secret put` prompts you
to paste the value:

```bash
# The two auth tokens (required — a missing ADMIN_TOKEN denies ALL writes by default)
bunx wrangler secret put ADMIN_TOKEN      # paste your write token
bunx wrangler secret put CLERK_TOKEN      # paste your read token

# AI keys — set the one(s) for the provider you use (see note below)
bunx wrangler secret put ANTHROPIC_API_KEY   # Claude (used for vision ingest + optionally chat)
bunx wrangler secret put DEEPSEEK_API_KEY    # DeepSeek (optional, chat only)
```

**About the AI keys — you have two options:**

1. **Set them as secrets here**, *or*
2. **Leave them unset and enter them at runtime** in the admin web under **Settings → AI provider**.
   Those are stored in the backend's `app_settings` table and **override** the env secrets. This is
   handy because you can rotate keys without redeploying. (This table is server-only and is *not*
   synced to the clerk phones or included in backups.)

Vision ingestion (reading catalog PDFs) currently uses **Claude**, so you need `ANTHROPIC_API_KEY`
(or the Settings equivalent) if you plan to ingest catalogs in production. The clerk **chat**
provider is selectable; if you set no AI keys at all, chat falls back to a keyless stub.

Optional tuning secrets (only if you want to override defaults): `CHAT_PROVIDER` (`claude` |
`deepseek` | `stub`), `CHAT_MODEL`, `VISION_MODEL`, `AI_CHAT`.

### 1c. Apply the database schema to the remote DB (one-time, plus after any schema change)

```bash
bun run db:migrate:remote      # applies ./drizzle migrations to the remote D1
```

### 1d. Deploy

```bash
bun run deploy                 # wrangler deploy
```

Wrangler prints the live URL, e.g. `https://wemo-backend.<your-subdomain>.workers.dev`. **Write this
down** — the admin and mobile apps both need it. Sanity-check it:

```bash
curl https://wemo-backend.<your-subdomain>.workers.dev/health   # -> {"ok":true}
```

### 1e. Backup & restore — carrying the catalog between deployments

**The whole point:** the expensive part of building the catalog is AI extraction (reading catalog
PDFs costs tokens and time). Its output lands as **rows in D1 + cropped diagram images in R2**.
Backup lets you snapshot *all* of that from one deployment and replay it into another **over HTTP**,
with no re-extraction. The usual use is **local dev → prod**: you ingest catalogs cheaply on your PC,
then push the finished catalog up once. It's also your **disaster-recovery** copy — run it
periodically so a bad edit or a lost database isn't the end of the world.

**What's in an archive.** One self-contained JSON file (`apps/backend/backups/wemo-<timestamp>.json`,
gitignored):

- The **14 catalog/data tables** — machines, variants, colors, parts, part numbers, color variants,
  aliases, substitutes, assemblies, assembly items, item resolutions, dots, assembly links, service
  items. Soft-deleted rows (tombstones) are included, so deletions carry over too.
- Every **R2 diagram image** those assemblies reference, embedded as base64.

**What's deliberately NOT in it:** `app_settings` (your AI keys) and `users`/auth. Those are
per-deployment — you set them fresh on each backend (step 1b). So a restore never overwrites prod's
secrets with dev's.

#### Take a backup

```bash
cd apps/backend

# From local dev — `bun run dev` must be running in another terminal:
bun run backup
#   -> Saved .../backups/wemo-2026-07-05T12-30-00.json
#      412 rows across 14 tables · 37 images · from http://127.0.0.1:8787

# From a deployed backend instead (token must match THAT deployment's ADMIN_TOKEN):
ADMIN_TOKEN=<that-backend's-admin-token> bun run backup https://wemo-backend.<sub>.workers.dev
```

Local commands default to `http://127.0.0.1:8787` with the dev token `dev-admin-key`. The URL can be
the first argument (as above) or the `BACKUP_URL` env var; the token always comes from `ADMIN_TOKEN`.

> Windows note: the scripts use `127.0.0.1`, **not** `localhost`, on purpose — Node's `fetch` prefers
> IPv6 `::1`, which `wrangler dev` doesn't bind on Windows, so `localhost` would hang/refuse.

#### Restore a backup

```bash
cd apps/backend

# Into local dev (default target):
bun run restore backups/wemo-2026-07-05T12-30-00.json

# Into prod — pass the URL, and ADMIN_TOKEN must be the PROD token:
ADMIN_TOKEN=<prod-admin-token> bun run restore backups/wemo-2026-07-05T12-30-00.json https://wemo-backend.<sub>.workers.dev
#   -> Restored 412 rows · 37 images into https://wemo-backend.<sub>.workers.dev
```

**Restore is idempotent** — every row is upserted by primary key (`INSERT … ON CONFLICT DO UPDATE`)
and every image is re-`put`. So restoring into an empty prod and re-restoring over an existing one
both converge to exactly the snapshot. Safe to re-run anytime.

**One thing to know:** restore is a **merge, not a mirror** — it inserts/updates the rows in the
archive but does **not** delete rows on the target that aren't in the archive. Restoring an *old*
backup won't remove parts you added *after* it (a genuine delete would need to have happened as a
soft-delete that's captured in a *newer* backup). For a true "reset to this snapshot", restore into a
freshly created empty database.

**Scale note:** the archive is a single JSON built in memory with base64 images. That's fine for a
shop-sized catalog (hundreds of rows, tens–hundreds of images). If it ever grows to thousands of
large images, expect the backup request to get heavy — at that point split by machine or move images
out of the archive. Not a concern today.

The CLI wrappers live at `apps/backend/scripts/backup.mjs` / `restore.mjs`; they call the
`GET /admin/backup` and `POST /admin/restore` routes (both `requireAdmin`). Admin **Settings**
Download/Restore buttons are a deferred follow-up — for now it's these commands.

---

## 2. Admin web — Cloudflare Pages

The admin app calls the backend at the **same origin** under `/api/*` (this avoids CORS entirely).
So in production we host the static site on Cloudflare Pages and add a **tiny proxy** that forwards
`/api/*` to your backend Worker. Nothing in the app code changes.

### 2a. Add the proxy function (one-time)

Create the file `apps/admin/functions/api/[[path]].js` with exactly this content:

```js
// Cloudflare Pages Function: proxies /api/* on the Pages site to the backend Worker,
// stripping the /api prefix. Keeps the admin same-origin so there is no CORS and the
// admin token never leaves the site's origin. Set BACKEND_URL as a Pages env var.
export function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join('/') : (params.path ?? '');
  const target = env.BACKEND_URL.replace(/\/+$/, '') + '/' + path + url.search;
  return fetch(new Request(target, request)); // preserves method, headers (Authorization), body
}
```

> Why this exists: the admin fetches `/api/machines`, `/api/assemblies/:id/image`, etc. In dev,
> `vite.config.ts` proxies `/api` → `127.0.0.1:8787`. In production this function does the same job.

### 2b. Build

```bash
cd apps/admin
bun install
bun run build                  # outputs the static site to apps/admin/dist
```

### 2c. Create the Pages project and deploy (one-time create, then re-deploy on each build)

```bash
cd apps/admin
bunx wrangler pages project create wemo-admin       # one-time; pick a production branch name when asked
bun run deploy
```

Then set the backend URL the proxy points at. In the **Cloudflare dashboard → Workers & Pages →
wemo-admin → Settings → Variables and Secrets**, add:

- **`BACKEND_URL`** = `https://wemo-backend.<your-subdomain>.workers.dev`

(Re-deploy once after adding the variable so the function picks it up.) Pages prints your admin URL,
e.g. `https://wemo-admin.pages.dev`.

### 2d. First login

Open the admin URL, go to **Settings**, paste your **`ADMIN_TOKEN`** into the token field, and click
**Test connection** (it calls `GET /auth/check`). Green = you're in. The token is stored in the
browser's `localStorage`, so you stay logged in on that browser. To "log out", clear it in Settings.

---

## 3. Clerk mobile — Android APK

Built on the main PC (Flutter + Android SDK). Commands run from `apps/mobile`.

### 3a. Build a release APK

```bash
cd apps/mobile
flutter pub get
flutter build apk --release      # -> build/app/outputs/flutter-apk/app-release.apk
```

Copy that `app-release.apk` to the shop phone (USB, Drive, email) and install it (the phone must
allow "install from unknown sources"). For a single phone this sideload is all you need — no Play
Store.

### 3b. Signing note (optional, fine to skip for one phone)

The release build is currently **signed with the debug key** (`android/app/build.gradle.kts` →
`release { signingConfig = signingConfigs.getByName("debug") }`). That installs and runs fine for
sideloading. It only matters if you later publish to the Play Store or want stable update signing —
then generate a keystore and wire it up per Flutter's
[app-signing guide](https://docs.flutter.dev/deployment/android#signing-the-app). Not required now.

### 3c. First-run config on the phone

Everything is entered on-device (nothing secret is compiled into the APK). Open the **Sync** tab:

- **Backend URL** → your production Worker, e.g. `https://wemo-backend.<your-subdomain>.workers.dev`.
  It **must be `https://`** — the app blocks cleartext `http://` except for local dev hosts
  (`10.0.2.2`, `localhost`, `127.0.0.1`). A `*.workers.dev` URL is HTTPS, so you're fine.
- **API key** → your **`CLERK_TOKEN`** (or the admin token). Without it, sync/chat return 401 and the
  app shows "Not authorized".

Tap **Sync now** (or **Force full sync**) to pull the catalog. After that, Browse and Search work
fully offline; the Assistant needs the backend online (and an AI key set on the backend).

---

## 4. Secrets & tokens — quick reference

| Name | Type | Where you set it | Where the matching value goes | Purpose |
|---|---|---|---|---|
| `ADMIN_TOKEN` | you invent | backend secret (`wrangler secret put`) | admin web → Settings | Authorizes **all writes**. |
| `CLERK_TOKEN` | you invent | backend secret | mobile app → Sync screen | Authorizes **read-only** sync/chat. |
| `ANTHROPIC_API_KEY` | from Anthropic | backend secret *or* admin Settings → AI | — | Vision ingest + (optional) chat. |
| `DEEPSEEK_API_KEY` | from DeepSeek | backend secret *or* admin Settings → AI | — | Optional chat provider. |
| `database_id` | from `d1 create` | `apps/backend/wrangler.jsonc` | — | Binds the Worker to your D1 DB. |
| `BACKEND_URL` | your Worker URL | Pages project → Variables | — | Tells the admin proxy where the backend is. |

Rotating a token = re-run `wrangler secret put <NAME>` (or edit AI keys in admin Settings), then
update the value in the client that uses it. No redeploy needed for secret changes.

---

## 5. Post-deploy smoke test (5 minutes)

1. `curl https://<backend>/health` → `{"ok":true}`.
2. Admin URL → Settings → paste `ADMIN_TOKEN` → **Test connection** is green.
3. Admin → Browse → a machine loads assemblies and a diagram with dots.
4. Phone → Sync → enter URL + `CLERK_TOKEN` → **Sync now** → row counts fill in.
5. Phone → Browse a machine, open a diagram, tap a dot; Search a part number.
6. Phone → Assistant → ask a question (needs backend online + an AI key set).

---

## 6. Redeploying later (the short version)

Once the one-time setup above is done, shipping changes is just running these from the **project root**:

```bash
# Backend & Admin web (all at once — note: use npm as Wrangler requires Node.js)
npm run deploy:all

# OR individually
npm run deploy:backend
npm run deploy:admin

# ONLY if the schema changed, run this first:
npm run db:migrate:remote

# Mobile (from apps/mobile) — then re-sideload the APK
cd apps/mobile
flutter build apk --release
```

Secrets, the D1 database, the R2 bucket, and the Pages `BACKEND_URL` all persist — you don't touch
them again unless you're rotating a token or changing where things point.
