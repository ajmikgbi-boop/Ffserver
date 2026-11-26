# CompanySync

Two-way folder sync for small teams, built to run on free tiers:

- **`/server`**: a **stateless** coordination server (Node.js, Express, Socket.io) for **Render.com Free**.
- **Cloudflare R2**: stores every file and every piece of state.
- **`/desktop-app`**: an **Electron** client for Windows and macOS (Linux works too). Everything happens inside the app.

```
 ┌───────────────────────┐   Socket.io (events, presign requests)   ┌─────────────────────────┐
 │  Desktop app (Electron)│ ◀────────────────────────────────────▶ │  Coordination server     │
 │  • chokidar watcher    │        https://sync.yourcompany.com      │  (Render free, 512 MB)   │
 │  • 3-way sync engine   │                                          │  • zero local disk state │
 │  • SHA-256 hashing     │                                          │  • presigns S3 URLs      │
 └──────────┬────────────┘                                          └────────────┬────────────┘
            │  PUT / GET file bytes directly (presigned URLs)                       │ S3 API
            ▼                                                                       ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Cloudflare R2 bucket                                                                       │
 │   workspaces/{serverCode}/{relative/file/path}    ← files, x-amz-meta-sha256 = content hash│
 │   _meta/{serverCode}/devices.json                 ← device registry (names, last sync)     │
 │   _meta/{serverCode}/activity.json                ← activity log                           │
 │   _meta/{serverCode}/manifest.json                ← hash cache (rebuildable from metadata) │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

File bytes never pass through the server, so its memory use stays flat whatever the file size. Because all state lives in R2, you can deploy the server to a **brand-new Render account** with the same four R2 variables and everything keeps working with no migration. Desktop apps reconnect on their own.

---

## Contents

1. [Directory structure](#1-directory-structure)
2. [How it works](#2-how-it-works)
3. [Deployment guide](#3-deployment-guide)
   - [3.1 Cloudflare R2 bucket and API token](#31-cloudflare-r2-bucket-and-api-token)
   - [3.2 Deploy `/server` to Render](#32-deploy-server-to-rendercom)
   - [3.3 Custom subdomain through Cloudflare DNS](#33-custom-subdomain-through-cloudflare-dns)
   - [3.4 UptimeRobot keep-alive](#34-uptimerobot-keep-alive-on-health)
   - [3.5 Build the Windows `.exe`](#35-build-the-windows-exe-installer)
   - [3.6 Moving the server to a new Render account](#36-moving-the-server-to-a-new-render-account-failover)
4. [Using the desktop app](#4-using-the-desktop-app)
5. [Local development](#5-local-development)
6. [Configuration reference](#6-configuration-reference)
7. [Security notes](#7-security-notes)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Directory structure

```
.
├── README.md                     ← this guide
├── render.yaml                   ← Render Blueprint (one-click deploy of /server)
├── .github/workflows/
│   └── build-desktop.yml         ← builds the Windows .exe / macOS .dmg on GitHub Actions
├── server/                       ← stateless coordination server (Render)
│   ├── package.json
│   ├── package-lock.json
│   ├── .env.example
│   └── src/
│       ├── index.js              ← Express app, /health, Socket.io, graceful shutdown
│       ├── config.js             ← environment variables
│       ├── r2.js                 ← R2 (S3 API): list/head/presign/multipart/copy
│       ├── workspace.js          ← per-Server-Code index, devices, activity (persisted to R2)
│       ├── socket.js             ← Socket.io protocol (auth, presign, commit, delete, devices)
│       ├── validation.js         ← input validation (codes, paths, hashes)
│       ├── util.js               ← concurrency helpers
│       └── logger.js
└── desktop-app/                  ← Electron client
    ├── package.json              ← includes electron-builder config (Windows NSIS .exe)
    ├── package-lock.json
    ├── build/icon.png            ← installer / app icon (electron-builder buildResources)
    ├── assets/
    │   ├── icon.png              ← window icon
    │   └── tray.png              ← system tray icon
    └── src/
        ├── main/
        │   ├── main.js           ← app lifecycle, window, tray, IPC, dialogs
        │   ├── session.js        ← one connection + one sync folder
        │   ├── cloud-client.js   ← Socket.io client (infinite auto-reconnect)
        │   ├── sync-engine.js    ← watcher, job queue, 3-way reconcile, transfers, conflicts
        │   ├── sync-state.js     ← per-folder "last synced" hashes (userData)
        │   ├── transfer.js       ← streaming presigned PUT/GET with hashing + progress
        │   ├── fs-utils.js       ← hashing, walking, ignore rules, atomic writes
        │   ├── config-store.js   ← userData/config.json
        │   └── logger.js         ← userData/logs/companysync.log
        ├── preload/preload.js    ← whitelisted IPC bridge (contextIsolation + sandbox)
        └── renderer/
            ├── index.html        ← connection screen + dashboard
            ├── styles.css        ← light/dark theme
            └── app.js            ← UI logic (file browser, devices, activity, drag & drop)
```

---

## 2. How it works

### Sync model

Each device keeps, per (Server Code, folder), the SHA-256 of the last version it knows to be identical locally and in R2 (the **base**). Every path is decided by comparing three hashes: **local**, **remote** (`x-amz-meta-sha256` in R2) and **base**:

| Local | Remote | Base | Action |
|---|---|---|---|
| = remote | = local | any | in sync |
| = base | changed | ✓ | download |
| changed | = base | ✓ | upload |
| changed | changed | any | **conflict**: cloud version keeps the name, local copy is saved as `name (نسخة متعارضة من <device> <date>).ext` ("conflicted copy from …") and uploaded |
| = base | missing | ✓ | deleted in cloud → move local file to Recycle Bin / Trash |
| present | missing | ✗ | new local file → upload |
| missing | = base | ✓ | deleted locally → delete from cloud |
| missing | present | ✗ | new cloud file → download |

This works across restarts. A device that was off for a week gets every create, edit and delete in both directions when it comes back. Safety nets:
- A missing sync folder (unplugged drive) never causes cloud deletions.
- An emptied folder or an emptied bucket triggers a full re-download or re-upload instead of mass deletes.
- Edits always win over deletes.

### Loop prevention
- **Active-sync lock set**: paths the engine is writing are locked. While a path is locked, a watcher event is dropped only if the file on disk still matches exactly what the engine wrote, so a real user edit made right after a download is not lost.
- **Hash comparison**: a local file whose SHA-256 equals the cloud hash is never uploaded again, so even a missed lock cannot cause a loop.
- Downloads go to `<folder>/.companysync/tmp`, are verified against the SHA-256, and only then move into place atomically.

### Server role (stateless)
- It presigns short-lived PUT, GET and multipart-part URLs. Files of 100 MiB or more use multipart uploads, with parts retried individually.
- It verifies each upload with `HEAD` (hash and size) before it broadcasts `file:added` / `file:updated` / `file:deleted` to the Server Code's room.
- It refuses to overwrite a version the client has not seen (optimistic concurrency via `baseSha256` / `expectedSha256`).
- Moves and renames become server-side `CopyObject` calls when the content already exists in the workspace.
- Objects uploaded outside the app (for example through the R2 dashboard) are hashed once and synced like any other file.
- Device registry, activity log and hash manifest are written back to R2 (debounced) and flushed on `SIGTERM`.

### Socket.io protocol (all requests use acknowledgements)

| Client → server | Purpose |
|---|---|
| `files:list` | full workspace index |
| `file:presign-upload` `{path, sha256, size, baseSha256}` | `exists` / `copied` / `conflict` / `upload` (single URL + signed headers, or multipart plan) |
| `file:presign-parts`, `file:complete-multipart`, `file:abort-multipart` | multipart flow |
| `file:commit` `{path, sha256, size}` | verify & broadcast a single-PUT upload |
| `file:presign-download` `{path}` | presigned GET |
| `file:delete` `{path, expectedSha256}` | delete & broadcast |
| `device:rename`, `device:remove`, `device:sync-report`, `devices:list`, `activity:list` | devices & activity |

Server → clients: `session:ready`, `file:added`, `file:updated`, `file:deleted`, `devices:update`, `activity:new`.

---

## 3. Deployment guide

> Total cost: **$0**. You need a Cloudflare account with a domain on Cloudflare DNS, a Render account, a GitHub account holding this repository, and optionally an UptimeRobot account.
> Dashboard labels change over time. If a button is named slightly differently, look for the closest match.

### 3.1 Cloudflare R2 bucket and API token

1. Cloudflare dashboard → **R2 Object Storage**. The first time, you activate R2 (the free plan needs a payment method on file but includes 10 GB-month of storage, 1 million Class A and 10 million Class B operations per month, and free egress).
2. **Create bucket** → name it, e.g. `companysync` → location *Automatic* → **Create**. Leave it **private**; no public access or CORS rules are needed, because the desktop app sends signed requests from Node.js, not from a browser.
3. Copy your **Account ID**, shown on the R2 overview page (also part of the S3 endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`).
4. R2 overview → **Manage R2 API Tokens** (or **API Tokens**) → **Create API token**:
   - Permissions: **Object Read & Write**
   - Specify bucket(s): **Apply to specific buckets only** → `companysync`
   - TTL: *Forever* (or your rotation policy)
   - **Create API Token** → copy the **Access Key ID** and **Secret Access Key**. The secret is shown only once.

You now have the four values: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME`.

> EU-jurisdiction bucket? Also set `R2_ENDPOINT=https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`.

### 3.2 Deploy `/server` to Render.com

Push this repository to GitHub, then either:

**Option A: Blueprint (one click)**
1. Render dashboard → **New** → **Blueprint** → connect the repository. `render.yaml` is detected.
2. Enter the R2 values when prompted. `ALLOWED_SERVER_CODES` may be left empty, but it is recommended (see [Security](#7-security-notes)).
3. **Apply**. Render installs and starts the service and checks `GET /health`.

**Option B: manual Web Service**
1. **New** → **Web Service** → select the repository.
2. Settings:
   | Field | Value |
   |---|---|
   | Root Directory | `server` |
   | Runtime | Node |
   | Build Command | `npm ci --omit=dev` |
   | Start Command | `node src/index.js` |
   | Instance Type | **Free** |
   | Health Check Path | `/health` (Advanced) |
3. **Environment** → add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` (and optionally `ALLOWED_SERVER_CODES`, `NODE_VERSION=22`). Do **not** set `PORT`: Render injects it.
4. **Create Web Service**. When the log shows `CompanySync server … listening`, open `https://<service>.onrender.com/health`. You should get `{"status":"ok",…}`.

The server writes nothing to disk, so no persistent disk is needed (free instances do not have one anyway).

### 3.3 Custom subdomain through Cloudflare DNS

1. Render → your service → **Settings** → **Custom Domains** → **Add Custom Domain** → `sync.yourcompany.com`. Render shows the CNAME target, `<service>.onrender.com`.
2. Cloudflare → your domain → **DNS** → **Records** → **Add record**:
   | Type | Name | Target | Proxy status |
   |---|---|---|---|
   | `CNAME` | `sync` | `<service>.onrender.com` | **DNS only** (grey cloud) for now |
   Remove any existing `A`/`AAAA` records for `sync`.
3. Back in Render, click **Verify**. Render issues the TLS certificate, which usually takes a few minutes.
4. Optional: switch the record to **Proxied** (orange cloud) to get Cloudflare's network in front. If you do:
   - **SSL/TLS** → **Overview** → encryption mode **Full (strict)**. Never use *Flexible*: it causes redirect loops with Render.
   - **Network** → **WebSockets** must be **On** (the default).
   - The server pings every 25 s, which stays well inside Cloudflare's 100 s idle timeout for WebSockets. It also sets `trust proxy` and permissive CORS, so it works behind the proxy unchanged.
5. Test: `https://sync.yourcompany.com/health` → `{"status":"ok",…}`.

Desktop apps always use **`https://sync.yourcompany.com`**, never the `onrender.com` URL. That is what makes failover transparent (3.6).

### 3.4 UptimeRobot keep-alive on `/health`

Render free web services spin down after about 15 minutes without inbound HTTP traffic, and the next request then waits roughly a minute for a cold start. Open WebSocket connections from desktop apps usually keep the service awake during working hours. A monitor covers nights and weekends and also alerts you when the server goes down.

1. UptimeRobot → **New monitor** (or **Add New Monitor**).
2. Monitor type **HTTP(s)**, URL `https://sync.yourcompany.com/health`, interval **5 minutes**.
3. Optional: monitor type **Keyword**, keyword `ok`.
4. Add an alert contact (email) → **Create monitor**.

`/health` never touches R2, so pings cost nothing. One always-on free service uses about 720–744 of Render's 750 free instance hours per month, so run only one free service per Render workspace.

### 3.5 Build the Windows `.exe` installer

**On a Windows machine** (Node.js 20 or newer):

```powershell
cd desktop-app
npm ci
npm run dist:win
```

The installer is written to `desktop-app\dist\CompanySync-Setup-1.0.0.exe`: a per-user NSIS installer with a choice of directory, Start-menu and desktop shortcuts.

**Without a Windows machine**: push the repository to GitHub → **Actions** → **Build desktop installers** → **Run workflow**. The `.exe` (and a macOS `.dmg`) appear under the run's **Artifacts**. Pushing a tag such as `v1.0.0` also triggers it.

Other targets: `npm run dist:mac` (on macOS) and `npm run dist:linux` (AppImage).

> The installer is unsigned, so Windows SmartScreen shows "Windows protected your PC" → **More info** → **Run anyway**. To sign it, set `CSC_LINK` (path or base64 of a `.pfx`) and `CSC_KEY_PASSWORD` before `npm run dist:win`. electron-builder then signs automatically.

### 3.6 Moving the server to a new Render account (failover)

1. Deploy `/server` on the new account exactly as in 3.2, using the **same four R2 variables**.
2. Add the same custom domain in the new service (3.3 step 1). In Cloudflare, change the `sync` CNAME target to the new `<service>.onrender.com`, then verify in Render.
3. Delete or suspend the old service.

Nothing else is needed. Files, hashes, the device list and the activity log are read back from R2. Every desktop app keeps retrying `https://sync.yourcompany.com` with infinite reconnection, attaches to the new server once DNS updates, and runs a full re-sync. No user action is required.

---

## 4. Using the desktop app

The desktop app's interface is **Arabic with a full right-to-left layout** (see [Language & RTL](#language--rtl) below). The English names in this section map to these on-screen labels:

| English | Arabic label |
|---|---|
| Server URL / Server Code / Device Name | عنوان الخادم / رمز الخادم / اسم الجهاز |
| Remember this server & auto-connect | تذكّر هذا الخادم واتصل تلقائيًا |
| Connect | اتصال |
| Switch Server / Disconnect | تبديل الخادم / قطع الاتصال |
| Rename Device | إعادة تسمية الجهاز |
| Open Folder / Change Folder | فتح المجلد / تغيير المجلد |
| Sync now | مزامنة الآن |
| Cloud Files / Activity | ملفات السحابة / النشاط |
| Connected / Offline / Syncing / Up to date | متصل / غير متصل / جاري المزامنة / محدّث |

- **Connection screen**: enter the **Server URL**, the **Server Code** and a **Device Name** (e.g. "Main Office PC"), and pick the sync folder (default `Documents/CompanySync`). With **Remember this server & auto-connect** checked, the settings are saved to `userData/config.json` and the app connects on every start, even offline or while the server wakes up. Unchecked, the URL and code are kept in memory only.
  - `userData` is `%APPDATA%\CompanySync` on Windows and `~/Library/Application Support/CompanySync` on macOS.
- **Dashboard** (in the order it appears on screen):
  - **Top bar**:
    - **Server Code** chip.
    - Live **connection status**: Connected, Reconnecting (with attempt counter), or Connection refused.
    - **Sync now**.
    - **Theme**: System, Light or Dark.
    - **Switch Server / Disconnect**.
  - **This device**:
    - Current name.
    - **Rename Device** button. The new name is pushed to every device instantly.
  - **Sync folder**:
    - Status: up to date, syncing N items, offline, or errors.
    - Live transfer progress bars.
    - **Open Folder** and **Change Folder**.
  - **Devices**:
    - Every device that has used the same Server Code, with an **Online/Offline** badge and **Last sync** time.
    - Offline devices can be removed from the list.
  - **Cloud Files** browser:
    - Folders and breadcrumbs.
    - Search (Ctrl/⌘+F).
    - Sortable columns.
    - Per-file status (Synced, Pending, Uploading, Downloading, Error, Skipped).
    - Actions: **Open**, **Show in folder**, **Save a copy…** (download anywhere), and **Delete**, which removes the file from the cloud and every device and moves local copies to the Recycle Bin.
  - **Drag & drop**: drop files or whole folders anywhere on the window. They are copied into the folder you are browsing and uploaded. Existing names are never overwritten; a numbered copy is created instead.
  - **Activity**: a real-time feed of who uploaded, updated or deleted which file, device online/offline/rename events, and local conflict or error notices.
- Closing the window keeps syncing in the **system tray**. The tray menu has Open, status, Open Sync Folder, Sync Now, Launch at Login and Quit.
- Ignored files: `.DS_Store`, `Thumbs.db`, `desktop.ini`, Office `~$` lock files, `*.tmp` / `*.part` / `*.crdownload` / `*.swp`, and the app's own `.companysync` folder.
- Logs: `userData/logs/companysync.log`.

### Language & RTL

- **Layout:** `index.html` is `lang="ar" dir="rtl"`, and the stylesheet uses logical properties (`inline-start/end`), so sidebars, cards, lists, toasts and dialogs mirror automatically. Direction-bearing icons (chevrons) are flipped. The font stack starts with `'Segoe UI'` and `Tahoma`, both of which ship complete Arabic glyphs, and letter-spacing is avoided because it breaks Arabic letter joining.
- **Bidi safety:**
  - The Server URL and Server Code inputs are `dir="ltr"`.
  - Paths (local folders and workspace files) render as a left-to-right run in which **each segment is isolated with its own direction**. Slashes never flip, and Arabic names keep their extension attached (`تقارير/الميزانية 2027.xlsx`).
  - User-provided names (devices, files) are wrapped in `<bdi>`, so e.g. `Laptop (Sales)` keeps its parentheses.
  - Text built in the main process (tray, notifications, dialogs) uses Unicode isolates (U+2066–U+2069) for the same purpose.
- **Confirmations:** confirmation dialogs are in-app RTL modals, because native message boxes follow the OS layout direction.
- **Where the strings live:** `desktop-app/src/main/i18n.js` (main process) and `desktop-app/src/renderer/i18n.js` (UI).
- **Grammar and errors:** plurals use `Intl.PluralRules('ar')` (one/two/few/many forms). Server errors (English) are translated on the client by error code.
- **Digits:** Western digits (`ar-u-nu-latn`) keep sizes, dates and versions consistent with paths and codes. Change `LOCALE` to `'ar'` in both i18n files for Arabic-Indic digits.
- **Server:** the server's own log and error text stays English; the desktop app never shows it untranslated.

---

## 5. Local development

**Server**
```bash
cd server
cp .env.example .env        # fill in your R2 credentials (or point R2_ENDPOINT at any S3-compatible store)
npm install
npm run dev                 # http://localhost:3000/health
```

**Desktop app**
```bash
cd desktop-app
npm install
npm start                   # or: npm run dev  (opens DevTools)
```
Connect to `http://localhost:3000` with any Server Code, e.g. `dev-team`.

To test two "devices" on one machine, run the packaged app on one account and `npm start` on another OS user. Each OS user has its own `userData` and therefore its own device ID.

---

## 6. Configuration reference

**Server environment variables**

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | – | `3000` | Injected by Render |
| `R2_ACCOUNT_ID` | ✓ | – | Cloudflare account ID (builds the R2 endpoint) |
| `R2_ACCESS_KEY_ID` | ✓ | – | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | ✓ | – | R2 API token secret |
| `R2_BUCKET_NAME` | ✓ | – | Bucket name |
| `R2_ENDPOINT` | – | `https://<account>.r2.cloudflarestorage.com` | Override, e.g. EU jurisdiction |
| `ALLOWED_SERVER_CODES` | – | *(any)* | Comma-separated allow-list of Server Codes |
| `TRUST_PROXY` | – | `1` | Express `trust proxy` |
| `PRESIGN_EXPIRES_SECONDS` | – | `3600` | Lifetime of presigned URLs |
| `MULTIPART_THRESHOLD_BYTES` | – | `104857600` | Multipart upload threshold (100 MiB) |
| `MULTIPART_PART_SIZE_BYTES` | – | `16777216` | Part size (16 MiB; grows automatically for huge files) |
| `INDEX_MAX_AGE_SECONDS` | – | `300` | Re-validate the cached index against R2 after this age |
| `LOG_LEVEL` | – | `info` | `debug`, `info`, `warn`, `error` |

**Server Code rules**: 3–64 characters from `A–Z a–z 0–9 - _`, starting with a letter or digit. Case-sensitive.

---

## 7. Security notes

- The **Server Code is the shared secret** of a workspace: anyone who knows the URL and the code can read and write its files. Use long, random codes (e.g. `acme-7f3k9q2m4x`) and set **`ALLOWED_SERVER_CODES`** so strangers cannot use your bucket with codes of their own.
- R2 credentials live only on the server. Clients receive presigned URLs that are scoped to a single object and operation and expire after `PRESIGN_EXPIRES_SECONDS`.
- Metadata (`x-amz-meta-sha256`) is part of the presigned signature, so a client cannot store a different hash than the one the server signed. The server re-checks hash and size with `HEAD` before announcing an upload, and every download is verified against the SHA-256 before it replaces a local file.
- The Electron UI runs with `contextIsolation`, `sandbox` and a strict Content-Security-Policy, without Node.js access. All file-system work happens in the main process behind a small whitelisted IPC bridge.
- Always use `https://` for the server URL in production.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| "did not respond … wake up" when connecting | The free instance is cold-starting. Retry after about 60 s, and set up UptimeRobot (3.4). |
| "This Server Code is not allowed" | Add the code to `ALLOWED_SERVER_CODES` on Render and redeploy, or fix a typo (codes are case-sensitive). |
| Redirect loop or SSL errors on the custom domain | Cloudflare SSL/TLS mode must be **Full (strict)**, not Flexible. |
| Stuck on "Reconnecting…" | Check `https://<your-domain>/health` in a browser. The app retries forever and resumes once the server answers. |
| Server log shows `AccessDenied` / `SignatureDoesNotMatch` | Wrong R2 keys, a token without **Object Read & Write**, or a token not scoped to this bucket. |
| A file shows **Skipped** | Its name is invalid on this OS (e.g. `:` on Windows), or it differs only by letter case from another file. Rename it on the device that created it. |
| `name (نسخة متعارضة من …)` files appear | The same file was edited on two devices before they could sync. Both versions are kept: merge them and delete the conflict copy. |
