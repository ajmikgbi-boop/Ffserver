'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const chokidar = require('chokidar');

const {
  INTERNAL_DIR,
  isIgnoredName,
  isIgnoredRel,
  isPortablePath,
  toRel,
  toAbs,
  hashFile,
  statOrNull,
  walk,
  conflictRel,
  numberedRel,
  pruneEmptyDirs,
  renameWithRetry,
} = require('./fs-utils');
const { uploadFile, downloadToFile, withRetry } = require('./transfer');
const { S, translateError } = require('./i18n');

/** How long a path stays in the active-sync lock set after the engine wrote it. */
const LOCK_GRACE_MS = 4000;
/** chokidar waits until a file's size is stable this long before reporting it. */
const WRITE_STABILITY_MS = 1200;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RESCHEDULES = 5;
/** Safety heuristics only kick in for folders with at least this many synced files. */
const SAFETY_MIN_ENTRIES = 20;
const PART_URL_BATCH = 20;
const PERMANENT_ERROR_CODES = new Set(['INVALID_PATH', 'INVALID_HASH', 'INVALID_SIZE']);

/** Thrown when a job must be re-evaluated from scratch (state changed underneath it). */
class RescheduleError extends Error {
  constructor(reason, { forceHash = false, delayMs = 0 } = {}) {
    super(reason);
    this.name = 'RescheduleError';
    this.forceHash = forceHash;
    this.delayMs = delayMs; // > 0: the file is still changing, look again later
  }
}

function mergeOpts(a, b) {
  return { forceHash: Boolean((a && a.forceHash) || (b && b.forceHash)) };
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

/**
 * Three-way sync decision for a single path.
 *   local  - { sha256 } of the file on disk, or null
 *   remote - { sha256 } of the object in R2, or null
 *   base   - { sha256 } of the last version known to be identical on both sides, or null
 */
function decide(local, remote, base) {
  if (local && remote) {
    if (local.sha256 === remote.sha256) return 'in-sync';
    if (base && local.sha256 === base.sha256) return 'download'; // only the cloud changed
    if (base && remote.sha256 === base.sha256) return 'upload'; // only this device changed
    return 'conflict'; // both changed (or first sync of two different files)
  }
  if (local) {
    if (base && local.sha256 === base.sha256) return 'delete-local'; // deleted in the cloud
    return 'upload'; // new here, or edited here after a remote delete (edit wins)
  }
  if (remote) {
    if (base && remote.sha256 === base.sha256) return 'delete-remote'; // deleted here
    return 'download'; // new in the cloud, or edited there after a local delete (edit wins)
  }
  return base ? 'forget' : 'none';
}

/**
 * Keeps one local folder and one cloud workspace in sync.
 *
 * Every trigger (file watcher event, remote broadcast, reconnect, periodic rescan)
 * just schedules a path. A small worker pool re-evaluates each scheduled path with
 * `decide()` and performs the resulting action. Jobs for the same path are
 * serialised and coalesced, so bursts of events never race each other.
 *
 * Loop prevention is two-fold:
 *   1. `syncLocks`: paths the engine itself is writing/deleting are ignored by the
 *      watcher until a grace period after the write completes.
 *   2. Hash comparison: even if an event slips through, a local file whose SHA-256
 *      equals the cloud's x-amz-meta-sha256 is recognised as already in sync.
 */
class SyncEngine extends EventEmitter {
  constructor({ root, client, state, deviceName, trash, concurrency = 3, logger = console, platform = process.platform }) {
    super();
    this.root = path.resolve(root);
    this.client = client;
    this.state = state;
    this.deviceName = deviceName;
    this.trash = trash || ((abs) => fsp.rm(abs, { force: true }));
    this.concurrency = concurrency;
    this.log = logger;
    this.platform = platform;
    this.caseInsensitive = platform === 'win32' || platform === 'darwin';
    this.tmpDir = path.join(this.root, INTERNAL_DIR, 'tmp');

    this.remote = new Map(); // rel -> remote file entry
    this.remoteLower = new Map(); // lowercased rel -> Set<rel> (case-clash detection)
    this.remoteReady = false;
    this.listing = false;
    this.remoteBuffer = [];

    this.queue = new Map(); // rel -> opts (insertion ordered)
    this.active = new Map(); // rel -> task { path, direction, bytes, total }
    this.again = new Map(); // rel -> opts for paths that changed while being processed
    this.syncLocks = new Set(); // active-sync lock set (paths the engine is writing)
    this.lockTimers = new Map();
    this.retryTimers = new Map();
    this.failures = new Map(); // rel -> consecutive failure count
    this.rescheduleCounts = new Map();
    this.errors = new Map(); // rel -> { message, at }
    this.skipped = new Map(); // rel -> reason (cannot be synced on this device)
    this.hashCache = new Map(); // rel -> { sha256, size, mtimeMs }
    this.dirCache = new Map(); // abs dir -> { names: Set, at }

    this.watcher = null;
    this.started = false;
    this.stopped = false;
    this.fullSyncRunning = false;
    this.fullSyncQueued = false;
    this.fullSyncRetryTimer = null;
    this.needsIdleReport = false;
    this.lastSyncedAt = null;
    this.abort = new AbortController();
    this.statusTimer = null;
    this.filesTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    const existing = await statOrNull(this.root);
    if (existing && !existing.isDirectory()) throw new Error(S.sync.rootIsFile(this.root));
    await fsp.mkdir(this.root, { recursive: true });
    if (!existing && this.state.size > 0) {
      // The folder vanished (deleted, renamed or an unmounted drive). Treating that as
      // "the user deleted everything" would wipe the cloud, so start from a clean base
      // and simply download everything again.
      this.log.warn(`[sync] ${this.root} did not exist; resetting sync state`);
      this.state.clear();
    }
    await fsp.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(this.tmpDir, { recursive: true });
    this._hideInternalDir();
    this._startWatcher();
    this.started = true;
    this._emitStatus();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    for (const t of this.retryTimers.values()) clearTimeout(t);
    for (const t of this.lockTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    this.lockTimers.clear();
    clearTimeout(this.statusTimer);
    clearTimeout(this.filesTimer);
    clearTimeout(this.fullSyncRetryTimer);
    this.queue.clear();
    if (this.watcher) {
      await this.watcher.close().catch(() => {});
      this.watcher = null;
    }
    await this.state.flush().catch((err) => this.log.warn('[sync] could not save sync state', err));
  }

  _hideInternalDir() {
    if (this.platform !== 'win32') return;
    execFile('attrib', ['+h', path.join(this.root, INTERNAL_DIR)], { windowsHide: true }, () => {});
  }

  _startWatcher() {
    const watcher = chokidar.watch(this.root, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      ignorePermissionErrors: true,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: WRITE_STABILITY_MS, pollInterval: 200 },
      ignored: (p) => {
        const rel = toRel(this.root, p);
        return rel ? isIgnoredRel(rel) : false;
      },
    });
    watcher
      .on('add', (p) => this._onLocalFile(p, 'add'))
      .on('change', (p) => this._onLocalFile(p, 'change'))
      .on('unlink', (p) => this._onLocalFile(p, 'unlink'))
      .on('addDir', (p) => this._onLocalDir(p, 'addDir'))
      .on('unlinkDir', (p) => this._onLocalDir(p, 'unlinkDir'))
      .on('error', (err) => this.log.warn('[sync] watcher error', err));
    this.watcher = watcher;
  }

  _onLocalFile(abs, kind) {
    const rel = toRel(this.root, abs);
    if (!rel || isIgnoredRel(rel)) return;
    this.dirCache.delete(path.dirname(abs));
    if (this.syncLocks.has(rel)) {
      // The engine itself just wrote or deleted this path. Drop the event only if the
      // disk still matches exactly what the engine wrote, so a real user edit made
      // seconds after a download is never lost.
      this._filterLockedEvent(rel, abs, kind).catch(() => this.schedule(rel, { forceHash: true }));
      return;
    }
    this.schedule(rel, { forceHash: kind !== 'unlink' });
  }

  async _filterLockedEvent(rel, abs, kind) {
    const st = await statOrNull(abs);
    const base = this.state.get(rel);
    if (kind === 'unlink') {
      if (!st && !base) return; // echo of our own delete
    } else if (st && base && st.isFile() && st.size === base.size && st.mtimeMs === base.mtimeMs) {
      return; // echo of our own download
    }
    this.schedule(rel, { forceHash: kind !== 'unlink' });
  }

  _onLocalDir(abs, kind) {
    const rel = toRel(this.root, abs);
    if (!rel || isIgnoredRel(rel)) return;
    this.dirCache.delete(path.dirname(abs));
    if (kind === 'unlinkDir') {
      // chokidar does not always report every file of a removed folder; re-check them all.
      const prefix = `${rel}/`;
      for (const key of [...this.state.keys()]) if (key.startsWith(prefix)) this.schedule(key);
    }
    // New folders need nothing here: chokidar reports each file inside once it is stable.
  }

  // ---------------------------------------------------------------------------
  // Remote events
  // ---------------------------------------------------------------------------

  /** Called for file:added / file:updated / file:deleted broadcasts. */
  handleRemoteEvent(kind, payload) {
    if (!payload || typeof payload.path !== 'string') return;
    if (this.listing) {
      this.remoteBuffer.push({ kind, payload });
      return;
    }
    this._applyRemoteEvent(kind, payload);
  }

  _applyRemoteEvent(kind, payload) {
    if (kind === 'file:deleted') this._applyRemoteDelete(payload.path);
    else this._applyRemoteFile(payload.path, payload);
    if (this.remoteReady) this.schedule(payload.path);
  }

  _applyRemoteFile(rel, file) {
    if (!file) {
      this._applyRemoteDelete(rel);
      return;
    }
    this.remote.set(rel, {
      path: rel,
      sha256: file.sha256,
      size: file.size,
      lastModified: file.lastModified,
      deviceId: file.deviceId || null,
      deviceName: file.deviceName || null,
    });
    const lower = rel.toLowerCase();
    let peers = this.remoteLower.get(lower);
    if (!peers) this.remoteLower.set(lower, (peers = new Set()));
    peers.add(rel);
    this._emitFiles();
  }

  _applyRemoteDelete(rel) {
    if (!this.remote.delete(rel)) return;
    const lower = rel.toLowerCase();
    const peers = this.remoteLower.get(lower);
    if (peers) {
      peers.delete(rel);
      if (!peers.size) this.remoteLower.delete(lower);
    }
    this._emitFiles();
  }

  _replaceRemote(files) {
    this.remote = new Map();
    this.remoteLower = new Map();
    for (const f of files) this._applyRemoteFile(f.path, f);
    this._emitFiles();
  }

  // ---------------------------------------------------------------------------
  // Full reconciliation
  // ---------------------------------------------------------------------------

  /** Compare the whole folder against the whole workspace. Runs on every (re)connect. */
  async fullSync(reason = 'manual') {
    if (!this.started || this.stopped) return;
    if (this.fullSyncRunning) {
      this.fullSyncQueued = true;
      return;
    }
    if (!this.client.connected) return;
    clearTimeout(this.fullSyncRetryTimer);
    this.fullSyncRunning = true;
    this.needsIdleReport = true;
    this._emitStatus();
    this.log.info(`[sync] full sync started (${reason})`);
    try {
      this.listing = true;
      this.remoteBuffer = [];
      let res;
      try {
        res = await this.client.request('files:list', {}, 180000);
      } finally {
        this.listing = false;
      }
      this._replaceRemote(Array.isArray(res.files) ? res.files : []);
      // Broadcasts that raced with the list response: apply only those newer than the list.
      const buffered = this.remoteBuffer;
      this.remoteBuffer = [];
      for (const { kind, payload } of buffered) {
        if (typeof payload.v !== 'number' || typeof res.v !== 'number' || payload.v > res.v) {
          if (kind === 'file:deleted') this._applyRemoteDelete(payload.path);
          else this._applyRemoteFile(payload.path, payload);
        }
      }
      this.remoteReady = true;

      const local = await walk(this.root);
      if (this.state.size >= SAFETY_MIN_ENTRIES && this.remote.size === 0 && local.size > 0) {
        this.state.clear();
        this.emit('notice', {
          level: 'warn',
          message: S.sync.cloudEmpty,
        });
      } else if (this.state.size >= SAFETY_MIN_ENTRIES && local.size === 0 && this.remote.size > 0) {
        this.state.clear();
        this.emit('notice', {
          level: 'warn',
          message: S.sync.folderEmpty,
        });
      }

      const all = new Set([...local.keys(), ...this.remote.keys(), ...this.state.keys()]);
      for (const rel of all) {
        if (isIgnoredRel(rel)) continue;
        if (this.active.has(rel)) this.again.set(rel, mergeOpts(this.again.get(rel), {}));
        else this.queue.set(rel, mergeOpts(this.queue.get(rel), {}));
      }
      this.log.info(`[sync] full sync queued ${all.size} paths (${local.size} local, ${this.remote.size} cloud)`);
    } catch (err) {
      if (err.code !== 'OFFLINE' && !this.stopped) {
        this.log.warn('[sync] full sync failed', err);
        this.emit('notice', { level: 'error', message: S.sync.listFailed(translateError(err)) });
        this.fullSyncRetryTimer = setTimeout(() => this.fullSync('retry'), 15000);
      }
    } finally {
      this.fullSyncRunning = false;
      if (this.fullSyncQueued) {
        this.fullSyncQueued = false;
        setImmediate(() => this.fullSync('queued'));
      }
      this._pump();
    }
  }

  // ---------------------------------------------------------------------------
  // Job queue
  // ---------------------------------------------------------------------------

  schedule(rel, opts = {}) {
    if (this.stopped) return;
    if (this.active.has(rel)) {
      this.again.set(rel, mergeOpts(this.again.get(rel), opts));
      return;
    }
    const retry = this.retryTimers.get(rel);
    if (retry) {
      clearTimeout(retry);
      this.retryTimers.delete(rel);
    }
    this.queue.set(rel, mergeOpts(this.queue.get(rel), opts));
    this._pump();
  }

  _canWork() {
    return this.started && !this.stopped && this.client.connected && this.remoteReady;
  }

  _pump() {
    if (this.stopped) return;
    if (this._canWork()) {
      while (this.active.size < this.concurrency && this.queue.size > 0) {
        const [rel, opts] = this.queue.entries().next().value;
        this.queue.delete(rel);
        this._run(rel, opts);
      }
    }
    this._emitStatus();
    this._checkIdle();
  }

  async _run(rel, opts) {
    const task = { path: rel, direction: 'check', bytes: 0, total: 0 };
    this.active.set(rel, task);
    try {
      await this._syncPath(rel, opts, task);
      if (!task.skipped) this.skipped.delete(rel);
      this.failures.delete(rel);
      this.rescheduleCounts.delete(rel);
      this.errors.delete(rel);
    } catch (err) {
      this._onJobError(rel, opts, err);
    } finally {
      this.active.delete(rel);
      const again = this.again.get(rel);
      if (again) {
        this.again.delete(rel);
        if (!this.retryTimers.has(rel)) this.queue.set(rel, mergeOpts(this.queue.get(rel), again));
      }
      if (task.direction !== 'check') this._emitFiles();
      this._pump();
    }
  }

  _onJobError(rel, opts, err) {
    if (this.stopped || err.name === 'AbortError') return;
    if (err instanceof RescheduleError && err.delayMs) {
      // Still being written (e.g. a large copy in progress): wait, do not count as a failure.
      const timer = setTimeout(() => {
        this.retryTimers.delete(rel);
        this.schedule(rel, { forceHash: true });
      }, err.delayMs);
      this.retryTimers.set(rel, timer);
      return;
    }
    if (err instanceof RescheduleError) {
      const count = (this.rescheduleCounts.get(rel) || 0) + 1;
      this.rescheduleCounts.set(rel, count);
      if (count <= MAX_RESCHEDULES) {
        this.log.info(`[sync] re-checking ${rel}: ${err.message}`);
        this.queue.set(rel, mergeOpts(this.queue.get(rel), { forceHash: err.forceHash }));
        return;
      }
      this.rescheduleCounts.delete(rel);
      err = new Error(S.sync.gaveUp(err.message));
    }
    if (err.code === 'OFFLINE' || !this.client.connected) {
      // The next successful (re)connect runs a full sync that covers this path.
      return;
    }
    const reason = translateError(err);
    this.errors.set(rel, { message: reason, at: Date.now() });
    if (PERMANENT_ERROR_CODES.has(err.code)) {
      this.emit('notice', { level: 'error', path: rel, message: S.sync.cannotSync(rel, reason) });
      return;
    }
    const attempt = (this.failures.get(rel) || 0) + 1;
    this.failures.set(rel, attempt);
    const delay = Math.min(MAX_RETRY_DELAY_MS, 2000 * 2 ** (attempt - 1));
    this.log.warn(`[sync] ${rel} failed (attempt ${attempt}, retry in ${Math.round(delay / 1000)}s): ${err.message}`);
    if (attempt === 1 || attempt % 5 === 0) {
      this.emit('notice', { level: 'error', path: rel, message: S.sync.couldNotSync(rel, reason) });
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(rel);
      this.schedule(rel, opts);
    }, delay);
    this.retryTimers.set(rel, timer);
  }

  // ---------------------------------------------------------------------------
  // Per-path reconciliation
  // ---------------------------------------------------------------------------

  async _syncPath(rel, opts, task) {
    if (isIgnoredRel(rel)) return;
    const clash = this._caseClash(rel);
    if (clash) {
      this._skip(rel, S.sync.caseClash(rel, clash), task);
      return;
    }
    const abs = toAbs(this.root, rel);
    const local = await this._localInfo(rel, abs, opts.forceHash);
    const remote = this.remote.get(rel) || null;
    const base = this.state.get(rel);

    switch (decide(local, remote, base)) {
      case 'in-sync':
        this._recordBase(rel, local);
        return;
      case 'forget':
        this.state.delete(rel);
        this.hashCache.delete(rel);
        return;
      case 'upload':
        await this._upload(rel, abs, local, remote, task);
        return;
      case 'download':
        await this._download(rel, abs, remote, local, task);
        return;
      case 'delete-local':
        await this._deleteLocal(rel, abs);
        return;
      case 'delete-remote':
        await this._deleteRemote(rel, remote);
        return;
      case 'conflict':
        await this._resolveConflict(rel, abs, remote, task);
        return;
      default:
    }
  }

  _caseClash(rel) {
    if (!this.caseInsensitive) return null;
    const peers = this.remoteLower.get(rel.toLowerCase());
    if (!peers || peers.size < 2 || !peers.has(rel)) return null;
    const sorted = [...peers].sort();
    const owner = sorted.find((p) => this.state.has(p)) || sorted[0];
    return owner === rel ? null : owner;
  }

  _skip(rel, reason, task) {
    task.skipped = true;
    if (!this.skipped.has(rel)) {
      this.skipped.set(rel, reason);
      this.emit('notice', { level: 'warn', path: rel, message: reason });
    }
  }

  /** True when `abs` exists with exactly this name (matters on case-insensitive file systems). */
  async _exactNameExists(abs) {
    if (!this.caseInsensitive) return true;
    const dir = path.dirname(abs);
    let cached = this.dirCache.get(dir);
    if (!cached || Date.now() - cached.at > 1500) {
      try {
        const names = await fsp.readdir(dir);
        cached = { names: new Set(names.map((n) => n.normalize('NFC'))), at: Date.now() };
      } catch {
        cached = { names: new Set(), at: Date.now() };
      }
      this.dirCache.set(dir, cached);
      if (this.dirCache.size > 500) this.dirCache.delete(this.dirCache.keys().next().value);
    }
    return cached.names.has(path.basename(abs).normalize('NFC'));
  }

  async _localInfo(rel, abs, forceHash) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const st = await statOrNull(abs);
      if (!st || !st.isFile()) return null;
      if (!(await this._exactNameExists(abs))) return null;
      if (!forceHash) {
        for (const cached of [this.state.get(rel), this.hashCache.get(rel)]) {
          if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
            return { sha256: cached.sha256, size: st.size, mtimeMs: st.mtimeMs };
          }
        }
      }
      const sha256 = await hashFile(abs);
      const after = await statOrNull(abs);
      if (after && after.size === st.size && after.mtimeMs === st.mtimeMs) {
        const info = { sha256, size: st.size, mtimeMs: st.mtimeMs };
        this.hashCache.set(rel, info);
        return info;
      }
    }
    throw new RescheduleError(S.sync.stillWriting, { forceHash: true, delayMs: 3000 });
  }

  _recordBase(rel, info) {
    const current = this.state.get(rel);
    if (current && current.sha256 === info.sha256 && current.size === info.size && current.mtimeMs === info.mtimeMs) return;
    this.state.set(rel, { sha256: info.sha256, size: info.size, mtimeMs: info.mtimeMs });
  }

  _lock(rel) {
    this.syncLocks.add(rel);
    const timer = this.lockTimers.get(rel);
    if (timer) {
      clearTimeout(timer);
      this.lockTimers.delete(rel);
    }
  }

  _unlockLater(rel) {
    if (!this.syncLocks.has(rel)) return;
    const existing = this.lockTimers.get(rel);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.lockTimers.delete(rel);
      this.syncLocks.delete(rel);
    }, LOCK_GRACE_MS + WRITE_STABILITY_MS);
    this.lockTimers.set(rel, timer);
  }

  _markWork() {
    this.needsIdleReport = true;
  }

  async _commit(event, payload) {
    try {
      const res = await this.client.request(event, payload, 120000);
      return res.file;
    } catch (err) {
      if (err.code === 'CONFLICT') {
        if (err.file !== undefined) this._applyRemoteFile(payload.path, err.file);
        throw new RescheduleError(err.message);
      }
      throw err;
    }
  }

  async _upload(rel, abs, local, remote, task) {
    task.direction = 'upload';
    task.total = local.size;
    task.bytes = 0;
    this._emitStatus();

    const res = await this.client.request('file:presign-upload', {
      path: rel,
      sha256: local.sha256,
      size: local.size,
      baseSha256: remote ? remote.sha256 : null,
    });
    if (res.status === 'exists' || res.status === 'copied') {
      this._applyRemoteFile(rel, res.file);
      this._recordBase(rel, local);
      this._markWork();
      return;
    }
    if (res.status === 'conflict') {
      this._applyRemoteFile(rel, res.file);
      throw new RescheduleError(S.sync.cloudChanged);
    }

    let file;
    if (res.mode === 'multipart') {
      file = await this._uploadMultipart(rel, abs, local, res, task);
    } else {
      const sent = await uploadFile({
        url: res.url,
        headers: res.headers,
        file: abs,
        signal: this.abort.signal,
        onProgress: (bytes) => {
          task.bytes = bytes;
          this._emitStatus();
        },
      });
      if (sent.sha256 !== local.sha256) {
        throw new RescheduleError(S.sync.changedDuringUpload, { forceHash: true, delayMs: 2000 });
      }
      file = await this._commit('file:commit', { path: rel, sha256: local.sha256, size: local.size });
    }
    this._applyRemoteFile(rel, file);
    this._recordBase(rel, local);
    this._markWork();
  }

  async _uploadMultipart(rel, abs, local, plan, task) {
    const { uploadId, partSize, partCount } = plan;
    const progress = new Map();
    const parts = [];
    try {
      for (let first = 1; first <= partCount; first += PART_URL_BATCH) {
        const numbers = [];
        for (let n = first; n < first + PART_URL_BATCH && n <= partCount; n++) numbers.push(n);
        const { parts: urls } = await this.client.request('file:presign-parts', { path: rel, uploadId, partNumbers: numbers });
        await mapLimit(urls, 3, async ({ partNumber, url }) => {
          const start = (partNumber - 1) * partSize;
          const end = Math.min(local.size, start + partSize) - 1;
          const result = await withRetry(
            () =>
              uploadFile({
                url,
                file: abs,
                start,
                end,
                signal: this.abort.signal,
                onProgress: (bytes) => {
                  progress.set(partNumber, bytes);
                  let total = 0;
                  for (const b of progress.values()) total += b;
                  task.bytes = total;
                  this._emitStatus();
                },
              }),
            { attempts: 4, signal: this.abort.signal },
          );
          if (!result.etag) throw new Error(S.sync.noEtag(partNumber));
          parts.push({ partNumber, etag: result.etag });
        });
      }
      const st = await statOrNull(abs);
      if (!st || st.size !== local.size || st.mtimeMs !== local.mtimeMs) {
        throw new RescheduleError(S.sync.changedDuringUpload, { forceHash: true, delayMs: 2000 });
      }
      return await this._commit('file:complete-multipart', {
        path: rel,
        uploadId,
        sha256: local.sha256,
        size: local.size,
        parts,
      });
    } catch (err) {
      this.client.request('file:abort-multipart', { path: rel, uploadId }).catch(() => {});
      throw err;
    }
  }

  async _download(rel, abs, remote, localBefore, task) {
    if (!isPortablePath(rel, this.platform)) {
      this._skip(rel, S.sync.notPortable(rel), task);
      return;
    }
    task.direction = 'download';
    task.total = remote.size;
    task.bytes = 0;
    this._emitStatus();

    let res;
    try {
      res = await this.client.request('file:presign-download', { path: rel });
    } catch (err) {
      if (err.code === 'NOT_FOUND') {
        this._applyRemoteDelete(rel);
        throw new RescheduleError(S.sync.deletedMeanwhile);
      }
      throw err;
    }
    if (res.file.sha256 !== remote.sha256) {
      this._applyRemoteFile(rel, res.file);
      throw new RescheduleError(S.sync.cloudChanged);
    }

    const tmp = path.join(this.tmpDir, `${crypto.randomUUID()}.download`);
    try {
      await fsp.mkdir(this.tmpDir, { recursive: true });
      await downloadToFile({
        url: res.url,
        dest: tmp,
        expectedSha256: remote.sha256,
        expectedSize: remote.size,
        signal: this.abort.signal,
        onProgress: (bytes) => {
          task.bytes = bytes;
          this._emitStatus();
        },
      });
      // Never clobber an edit the user made while we were downloading.
      const now = await statOrNull(abs);
      const unchanged = localBefore
        ? now && now.isFile() && now.size === localBefore.size && now.mtimeMs === localBefore.mtimeMs
        : !now;
      if (!unchanged) throw new RescheduleError(S.sync.changedDuringDownload, { forceHash: true });

      this._lock(rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      if (remote.lastModified) {
        const when = new Date(remote.lastModified);
        await fsp.utimes(tmp, when, when).catch(() => {});
      }
      await renameWithRetry(tmp, abs);
      this.dirCache.delete(path.dirname(abs));
      const st = await fsp.stat(abs);
      this.hashCache.delete(rel);
      this._recordBase(rel, { sha256: remote.sha256, size: st.size, mtimeMs: st.mtimeMs });
      this._markWork();
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      this._unlockLater(rel);
    }
  }

  async _deleteLocal(rel, abs) {
    this._lock(rel);
    try {
      try {
        await this.trash(abs);
      } catch {
        await fsp.rm(abs, { force: true });
      }
      this.state.delete(rel);
      this.hashCache.delete(rel);
      this.dirCache.delete(path.dirname(abs));
      await pruneEmptyDirs(this.root, path.dirname(abs));
      this._markWork();
    } finally {
      this._unlockLater(rel);
    }
  }

  async _deleteRemote(rel, remote) {
    const res = await this.client.request('file:delete', { path: rel, expectedSha256: remote.sha256 });
    if (res.status === 'conflict') {
      this._applyRemoteFile(rel, res.file);
      throw new RescheduleError(S.sync.cloudChanged);
    }
    this._applyRemoteDelete(rel);
    this.state.delete(rel);
    this.hashCache.delete(rel);
    this._markWork();
  }

  async _resolveConflict(rel, abs, remote, task) {
    // Keep both versions: the cloud version keeps the original name (it is what every
    // other device already has); this device's version is renamed and uploaded.
    const now = new Date();
    let target = conflictRel(rel, this.deviceName, now);
    for (let n = 2; (await statOrNull(toAbs(this.root, target))) || this.remote.has(target); n++) {
      target = numberedRel(conflictRel(rel, this.deviceName, now), n);
    }
    this._lock(rel);
    try {
      await renameWithRetry(abs, toAbs(this.root, target));
    } finally {
      this._unlockLater(rel);
    }
    this.hashCache.delete(rel);
    this.dirCache.delete(path.dirname(abs));
    this.emit('notice', {
      level: 'warn',
      path: rel,
      message: S.sync.conflict(rel, target),
    });
    this.schedule(target, { forceHash: true });
    await this._download(rel, abs, remote, null, task);
  }

  // ---------------------------------------------------------------------------
  // Actions requested from the UI
  // ---------------------------------------------------------------------------

  localPath(rel) {
    return toAbs(this.root, rel);
  }

  async isAvailableLocally(rel) {
    const st = await statOrNull(toAbs(this.root, rel));
    return Boolean(st && st.isFile());
  }

  async _freeRel(rel) {
    let candidate = rel;
    for (let n = 2; (await statOrNull(toAbs(this.root, candidate))) || this.remote.has(candidate); n++) {
      candidate = numberedRel(rel, n);
    }
    return candidate;
  }

  /**
   * Copy files/folders (e.g. dropped onto the window) into the sync folder and upload
   * them. Existing names are never overwritten; a numbered copy is created instead.
   */
  async importPaths(sources, targetDir = '') {
    const dirRel = String(targetDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const destDir = dirRel ? toAbs(this.root, dirRel) : this.root;
    await fsp.mkdir(destDir, { recursive: true });
    let count = 0;
    for (const source of sources) {
      const src = path.resolve(source);
      const st = await statOrNull(src);
      if (!st) continue;
      const name = path.basename(src).normalize('NFC');
      if (isIgnoredName(name)) continue;
      const alreadyInside = toRel(this.root, src);
      if (alreadyInside && path.dirname(src) === destDir) {
        // Dropped a file that already lives in this folder: just make sure it is synced.
        if (st.isFile()) this.schedule(alreadyInside, { forceHash: true });
        continue;
      }
      const destRel = await this._freeRel(dirRel ? `${dirRel}/${name}` : name);
      const destAbs = toAbs(this.root, destRel);
      if (st.isDirectory()) {
        const relToSrc = path.relative(src, destAbs);
        if (!relToSrc.startsWith('..') && !path.isAbsolute(relToSrc)) continue; // folder into itself
        await fsp.cp(src, destAbs, {
          recursive: true,
          force: false,
          errorOnExist: false,
          filter: (p) => !isIgnoredName(path.basename(p)),
        });
        const files = await walk(this.root, destRel);
        for (const rel of files.keys()) {
          this.schedule(rel, { forceHash: true });
          count++;
        }
      } else if (st.isFile()) {
        await fsp.copyFile(src, destAbs, fs.constants.COPYFILE_EXCL);
        this.schedule(destRel, { forceHash: true });
        count++;
      }
    }
    return count;
  }

  /** Download the cloud version of a file to an arbitrary location ("Save a copy…"). */
  async saveRemoteCopy(rel, dest, onProgress) {
    const res = await this.client.request('file:presign-download', { path: rel });
    const tmp = `${dest}.${crypto.randomBytes(4).toString('hex')}.part`;
    try {
      await downloadToFile({
        url: res.url,
        dest: tmp,
        expectedSha256: res.file.sha256,
        expectedSize: res.file.size,
        signal: this.abort.signal,
        onProgress,
      });
      await renameWithRetry(tmp, dest);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
    return res.file;
  }

  /** Delete a file from the cloud. The broadcast that follows removes local copies everywhere. */
  async deleteRemoteFile(rel) {
    const remote = this.remote.get(rel);
    if (!remote) return { status: 'missing' };
    const res = await this.client.request('file:delete', { path: rel, expectedSha256: remote.sha256 });
    if (res.status === 'conflict') {
      this._applyRemoteFile(rel, res.file);
      const err = new Error(S.sync.changedByOther);
      err.code = 'CONFLICT';
      throw err;
    }
    return res;
  }

  filesUnder(prefix) {
    const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
    return [...this.remote.keys()].filter((rel) => rel.startsWith(p));
  }

  // ---------------------------------------------------------------------------
  // Status for the UI
  // ---------------------------------------------------------------------------

  listFiles() {
    const files = [];
    for (const file of this.remote.values()) {
      const base = this.state.get(file.path);
      const task = this.active.get(file.path);
      let status = 'pending';
      if (task && task.direction === 'upload') status = 'uploading';
      else if (task && task.direction === 'download') status = 'downloading';
      else if (this.skipped.has(file.path)) status = 'skipped';
      else if (this.errors.has(file.path)) status = 'error';
      else if (base && base.sha256 === file.sha256) status = 'synced';
      files.push({ ...file, status });
    }
    return files;
  }

  getStatus() {
    const busy = this.fullSyncRunning || this.queue.size > 0 || this.active.size > 0;
    let state;
    if (!this.started || this.stopped) state = 'stopped';
    else if (!this.client.connected) state = 'offline';
    else if (!this.remoteReady || this.fullSyncRunning) state = 'scanning';
    else if (busy) state = 'syncing';
    else if (this.errors.size) state = 'error';
    else state = 'idle';
    const transfers = [...this.active.values()]
      .filter((t) => t.direction !== 'check')
      .map((t) => ({ path: t.path, direction: t.direction, bytes: t.bytes, total: t.total }));
    return {
      state,
      root: this.root,
      pending: this.queue.size + this.active.size,
      transfers,
      errorCount: this.errors.size,
      errors: [...this.errors.entries()].slice(-10).map(([p, e]) => ({ path: p, message: e.message, at: e.at })),
      skippedCount: this.skipped.size,
      lastSyncedAt: this.lastSyncedAt,
      remoteCount: this.remote.size,
    };
  }

  _emitStatus() {
    if (this.statusTimer || this.stopped) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (!this.stopped) this.emit('status', this.getStatus());
    }, 200);
  }

  _emitFiles() {
    if (this.filesTimer || this.stopped) return;
    this.filesTimer = setTimeout(() => {
      this.filesTimer = null;
      if (!this.stopped) this.emit('files');
    }, 300);
  }

  _checkIdle() {
    if (this.queue.size || this.active.size || this.fullSyncRunning || !this._canWork()) return;
    if (this.needsIdleReport) {
      this.needsIdleReport = false;
      this.lastSyncedAt = Date.now();
      this.emit('idle');
      this._emitStatus();
    }
  }
}

module.exports = { SyncEngine, decide, RescheduleError };
