'use strict';

const log = require('./logger');
const { SyncError, normalizeRelPath, isSha256 } = require('./validation');
const { mapLimit, Semaphore, randomId } = require('./util');

const META_VERSION = 1;
const EXTERNAL_DEVICE_NAME = 'Cloud storage';
const MAX_EXTERNAL_ACTIVITY = 50;

function publicFile(entry) {
  return {
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
    lastModified: entry.lastModified,
    deviceId: entry.deviceId || null,
    deviceName: entry.deviceName || null,
  };
}

function sanitizeDevice(raw) {
  return {
    id: String(raw.id),
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 64) : 'Unnamed device',
    platform: typeof raw.platform === 'string' ? raw.platform.slice(0, 32) : null,
    appVersion: typeof raw.appVersion === 'string' ? raw.appVersion.slice(0, 32) : null,
    firstSeen: Number(raw.firstSeen) || Date.now(),
    lastSeen: Number(raw.lastSeen) || null,
    lastSync: Number(raw.lastSync) || null,
  };
}

/**
 * All server-side state of one Server Code.
 *
 * Nothing here is authoritative on its own: files live in R2 under
 * `workspaces/{code}/`, and the device registry, activity log and a hash manifest
 * (a cache of x-amz-meta-sha256 keyed by ETag) are persisted to R2 under
 * `_meta/{code}/`. A brand-new server pointed at the same bucket rebuilds the
 * exact same state on first use.
 */
class Workspace {
  constructor({ code, storage, config, broadcast }) {
    this.code = code;
    this.storage = storage;
    this.config = config;
    this.broadcast = broadcast;
    this.filePrefix = `workspaces/${code}/`;
    this.metaPrefix = `_meta/${code}/`;

    this.index = new Map(); // relPath -> entry
    this.indexBuiltAt = 0;
    this.indexing = null;
    this.mutatedDuringIndex = new Set();
    this.hashLimiter = new Semaphore(2);

    this.devices = new Map(); // deviceId -> device record (persisted)
    this.connections = new Map(); // deviceId -> Set<socketId> (memory only)
    this.offlineTimers = new Map();

    this.activity = [];
    this.dirty = { manifest: false, devices: false, activity: false };
    this.flushTimer = null;
    this.flushing = null;
    this.flushAgain = false;
    this.lastActiveAt = Date.now();
    this.version = 0; // increments on every file mutation; useful for debugging client ordering
  }

  get room() {
    return `ws:${this.code}`;
  }

  objectKey(relPath) {
    return this.filePrefix + relPath;
  }

  // ---------------------------------------------------------------------------
  // Loading & persistence
  // ---------------------------------------------------------------------------

  async load() {
    const [devicesDoc, activityDoc] = await Promise.all([
      this._readMeta('devices.json'),
      this._readMeta('activity.json'),
    ]);
    if (devicesDoc && Array.isArray(devicesDoc.devices)) {
      for (const raw of devicesDoc.devices) {
        if (raw && typeof raw.id === 'string') this.devices.set(raw.id, sanitizeDevice(raw));
      }
    }
    if (activityDoc && Array.isArray(activityDoc.entries)) {
      this.activity = activityDoc.entries.filter((e) => e && e.id && e.ts).slice(-this.config.activityLimit);
    }
    log.info(`[${this.code}] workspace loaded (${this.devices.size} devices, ${this.activity.length} activity entries)`);
  }

  async _readMeta(name) {
    try {
      return await this.storage.getJson(this.metaPrefix + name);
    } catch (err) {
      if (err instanceof SyntaxError) {
        log.warn(`[${this.code}] ${name} is corrupt and will be rebuilt: ${err.message}`);
        return null;
      }
      throw err; // transient storage errors must not be mistaken for "no data"
    }
  }

  _markDirty(kind) {
    this.dirty[kind] = true;
    this._scheduleFlush(this.config.flushDelayMs);
  }

  _scheduleFlush(delay) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => log.warn(`[${this.code}] flush failed`, err));
    }, delay);
    this.flushTimer.unref();
  }

  /** Persist dirty metadata to R2. Safe to call concurrently. */
  async flush() {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushing = (async () => {
      const jobs = [];
      const write = (kind, name, body) => {
        this.dirty[kind] = false;
        jobs.push(
          this.storage.putJson(this.metaPrefix + name, body).catch((err) => {
            this.dirty[kind] = true;
            throw err;
          }),
        );
      };
      if (this.dirty.devices) {
        write('devices', 'devices.json', {
          version: META_VERSION,
          updatedAt: new Date().toISOString(),
          devices: [...this.devices.values()],
        });
      }
      if (this.dirty.activity) {
        write('activity', 'activity.json', {
          version: META_VERSION,
          updatedAt: new Date().toISOString(),
          entries: this.activity,
        });
      }
      // Never write a manifest before the index has been built from R2 at least once,
      // otherwise an empty manifest could overwrite a good one.
      if (this.dirty.manifest && this.indexBuiltAt) {
        const files = {};
        for (const entry of this.index.values()) {
          files[entry.path] = {
            sha256: entry.sha256,
            size: entry.size,
            etag: entry.etag,
            lastModified: entry.lastModified,
            deviceId: entry.deviceId || null,
            deviceName: entry.deviceName || null,
          };
        }
        write('manifest', 'manifest.json', {
          version: META_VERSION,
          updatedAt: new Date().toISOString(),
          files,
        });
      }
      const results = await Promise.allSettled(jobs);
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length) {
        log.warn(`[${this.code}] ${failures.length} metadata write(s) failed; retrying soon`, failures[0].reason);
        this._scheduleFlush(5000);
      }
    })().finally(() => {
      this.flushing = null;
      if (this.flushAgain) {
        this.flushAgain = false;
        this._scheduleFlush(250);
      }
    });
    return this.flushing;
  }

  // ---------------------------------------------------------------------------
  // File index
  // ---------------------------------------------------------------------------

  /**
   * Make sure the in-memory index exists. The first call waits for a full build;
   * later calls trigger a background re-validation when the index is stale.
   */
  async ensureIndex() {
    if (!this.indexBuiltAt) return this.rebuildIndex();
    if (Date.now() - this.indexBuiltAt > this.config.indexMaxAgeMs) {
      this.rebuildIndex().catch((err) => log.warn(`[${this.code}] background re-index failed`, err));
    }
    return undefined;
  }

  rebuildIndex() {
    if (!this.indexing) {
      this.indexing = this._rebuildIndex().finally(() => {
        this.indexing = null;
      });
    }
    return this.indexing;
  }

  async _rebuildIndex() {
    const firstBuild = !this.indexBuiltAt;
    const startedAt = Date.now();
    let baseline = this.index;

    if (firstBuild) {
      baseline = new Map();
      const manifest = await this._readMeta('manifest.json');
      if (manifest && manifest.files && typeof manifest.files === 'object') {
        for (const [rel, e] of Object.entries(manifest.files)) {
          if (e && isSha256(e.sha256) && typeof e.etag === 'string') {
            baseline.set(rel, {
              path: rel,
              sha256: e.sha256,
              size: Number(e.size) || 0,
              etag: e.etag,
              lastModified: Number(e.lastModified) || 0,
              deviceId: e.deviceId || null,
              deviceName: e.deviceName || null,
            });
          }
        }
      }
    }

    const objects = await this.storage.listAll(this.filePrefix);
    const next = new Map();
    const needHead = [];
    for (const obj of objects) {
      const rel = obj.key.slice(this.filePrefix.length);
      let canonical;
      try {
        canonical = normalizeRelPath(rel);
      } catch {
        continue; // folder placeholders ("dir/") or keys we would never produce
      }
      if (canonical !== rel) continue;
      const prev = baseline.get(rel);
      if (prev && prev.etag === obj.etag && isSha256(prev.sha256)) {
        next.set(rel, { ...prev, size: obj.size, lastModified: obj.lastModified });
      } else {
        needHead.push({ rel, obj, prev });
      }
    }

    let hashed = 0;
    await mapLimit(needHead, 16, async ({ rel, obj, prev }) => {
      const head = await this.storage.head(obj.key);
      if (!head) return; // deleted while listing
      let sha256 = String(head.metadata.sha256 || '').toLowerCase();
      if (!isSha256(sha256)) {
        // Object was uploaded outside the app (e.g. via the R2 dashboard). Hash it by
        // streaming it once; the result is cached in the manifest keyed by ETag so it is
        // never recomputed. We deliberately do NOT rewrite the object's metadata in
        // place, because a copy-onto-itself could race with a concurrent upload.
        sha256 = await this.hashLimiter.run(() => this.storage.sha256Of(obj.key));
        hashed++;
      }
      const deviceId = head.metadata['device-id'] || null;
      const knownDevice = deviceId ? this.devices.get(deviceId) : null;
      next.set(rel, {
        path: rel,
        sha256,
        size: head.size,
        etag: head.etag,
        lastModified: head.lastModified,
        deviceId,
        deviceName: (prev && prev.deviceName) || (knownDevice && knownDevice.name) || EXTERNAL_DEVICE_NAME,
      });
    });

    // Changes committed while we were listing are newer than what we listed.
    for (const rel of this.mutatedDuringIndex) {
      const live = this.index.get(rel);
      if (live) next.set(rel, live);
      else next.delete(rel);
    }
    this.mutatedDuringIndex.clear();

    const previous = this.index;
    this.index = next;
    this.indexBuiltAt = Date.now();

    let changes = 0;
    if (firstBuild) {
      if (needHead.length || next.size !== baseline.size) this._markDirty('manifest');
    } else {
      changes = this._broadcastExternalChanges(previous, next);
      if (changes || needHead.length) this._markDirty('manifest');
    }

    log.info(
      `[${this.code}] index ${firstBuild ? 'built' : 'refreshed'}: ${next.size} files, ` +
        `${needHead.length} inspected, ${hashed} hashed, ${changes} external changes (${Date.now() - startedAt} ms)`,
    );
  }

  /** Broadcast differences found by a re-index (objects changed outside this server's knowledge). */
  _broadcastExternalChanges(previous, next) {
    let count = 0;
    const emit = (type, entry) => {
      count++;
      this.version++;
      const file = type === 'deleted' ? { path: entry.path } : publicFile(entry);
      this.broadcast(`file:${type}`, { ...file, v: this.version, ts: Date.now(), source: 'reindex' });
      if (count <= MAX_EXTERNAL_ACTIVITY) {
        this.addActivity({
          type,
          path: entry.path,
          size: type === 'deleted' ? undefined : entry.size,
          deviceId: entry.deviceId || null,
          deviceName: entry.deviceName || EXTERNAL_DEVICE_NAME,
        });
      }
    };
    for (const [rel, entry] of next) {
      const prev = previous.get(rel);
      if (!prev) emit('added', entry);
      else if (prev.sha256 !== entry.sha256) emit('updated', entry);
    }
    for (const [rel, entry] of previous) {
      if (!next.has(rel)) emit('deleted', entry);
    }
    if (count > MAX_EXTERNAL_ACTIVITY) {
      this.addActivity({
        type: 'bulk',
        deviceId: null,
        deviceName: EXTERNAL_DEVICE_NAME,
        detail: `${count - MAX_EXTERNAL_ACTIVITY} more changes detected in cloud storage`,
      });
    }
    return count;
  }

  listFiles() {
    return [...this.index.values()].map(publicFile);
  }

  getFile(relPath) {
    const entry = this.index.get(relPath);
    return entry ? publicFile(entry) : null;
  }

  findDuplicate(sha256, size, excludePath) {
    for (const entry of this.index.values()) {
      if (entry.sha256 === sha256 && entry.size === size && entry.path !== excludePath) return entry;
    }
    return null;
  }

  _touch(relPath) {
    if (this.indexing) this.mutatedDuringIndex.add(relPath);
  }

  /**
   * Verify that an object a client uploaded really is in R2 with the claimed hash,
   * then record it and notify every device in the workspace.
   */
  async commitUpload({ path: relPath, sha256, size, device }) {
    const head = await this.storage.head(this.objectKey(relPath));
    if (!head) {
      throw new SyncError('NOT_FOUND', `Upload of "${relPath}" was not found in storage.`);
    }
    const storedHash = String(head.metadata.sha256 || '').toLowerCase();
    if (storedHash !== sha256) {
      throw new SyncError(
        'CONFLICT',
        `"${relPath}" in storage does not match this upload (another device may have replaced it).`,
        { file: this.getFile(relPath) },
      );
    }
    if (typeof size === 'number' && head.size !== size) {
      throw new SyncError('SIZE_MISMATCH', `Stored size of "${relPath}" does not match the upload.`);
    }
    return this.upsert(
      {
        path: relPath,
        sha256,
        size: head.size,
        etag: head.etag,
        lastModified: head.lastModified,
        deviceId: device.id,
        deviceName: device.name,
      },
      device,
    );
  }

  upsert(entry, device) {
    const prev = this.index.get(entry.path);
    this._touch(entry.path);
    this.index.set(entry.path, entry);
    this._markDirty('manifest');
    this.lastActiveAt = Date.now();
    if (prev && prev.sha256 === entry.sha256) {
      return { changed: false, file: publicFile(entry) };
    }
    const type = prev ? 'updated' : 'added';
    this.version++;
    this.broadcast(`file:${type}`, { ...publicFile(entry), v: this.version, ts: Date.now() });
    this.addActivity({ type, path: entry.path, size: entry.size, deviceId: device.id, deviceName: device.name });
    this.markSynced(device.id);
    return { changed: true, type, file: publicFile(entry) };
  }

  async deleteFile({ path: relPath, expectedSha256, device }) {
    const current = this.index.get(relPath);
    if (!current) return { status: 'missing' };
    if (expectedSha256 && current.sha256 !== expectedSha256) {
      return { status: 'conflict', file: publicFile(current) };
    }
    const key = this.objectKey(relPath);
    await this.storage.delete(key);
    // Re-read after the await: another device may have committed or deleted meanwhile.
    const latest = this.index.get(relPath);
    if (!latest) return { status: 'deleted' };
    if (latest !== current) {
      const head = await this.storage.head(key);
      const stillThere = head && String(head.metadata.sha256 || '').toLowerCase() === latest.sha256;
      if (stillThere && this.index.get(relPath) === latest) {
        return { status: 'conflict', file: publicFile(latest) };
      }
      if (this.index.get(relPath) !== latest) return { status: 'conflict', file: this.getFile(relPath) };
    }
    this._touch(relPath);
    this.index.delete(relPath);
    this._markDirty('manifest');
    this.version++;
    this.broadcast('file:deleted', { path: relPath, v: this.version, ts: Date.now(), deviceId: device.id, deviceName: device.name });
    this.addActivity({ type: 'deleted', path: relPath, size: current.size, deviceId: device.id, deviceName: device.name });
    this.markSynced(device.id);
    this.lastActiveAt = Date.now();
    return { status: 'deleted' };
  }

  // ---------------------------------------------------------------------------
  // Devices
  // ---------------------------------------------------------------------------

  isOnline(deviceId) {
    const sockets = this.connections.get(deviceId);
    return !!sockets && sockets.size > 0;
  }

  listDevices() {
    return [...this.devices.values()]
      .map((d) => ({ ...d, online: this.isOnline(d.id) }))
      .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }

  broadcastDevices() {
    this.broadcast('devices:update', { devices: this.listDevices() });
  }

  deviceConnected(socketId, info) {
    const now = Date.now();
    const wasOnline = this.isOnline(info.id);
    let sockets = this.connections.get(info.id);
    if (!sockets) {
      sockets = new Set();
      this.connections.set(info.id, sockets);
    }
    sockets.add(socketId);

    const pendingOffline = this.offlineTimers.get(info.id);
    if (pendingOffline) {
      clearTimeout(pendingOffline);
      this.offlineTimers.delete(info.id);
    }

    const existing = this.devices.get(info.id);
    this.devices.set(info.id, {
      id: info.id,
      name: info.name,
      platform: info.platform || (existing && existing.platform) || null,
      appVersion: info.appVersion || (existing && existing.appVersion) || null,
      firstSeen: (existing && existing.firstSeen) || now,
      lastSeen: now,
      lastSync: (existing && existing.lastSync) || null,
    });

    const longAbsence = !existing || !existing.lastSeen || now - existing.lastSeen > 2 * 60 * 1000;
    if (!wasOnline && !pendingOffline && longAbsence) {
      this.addActivity({ type: 'device-online', deviceId: info.id, deviceName: info.name });
    }
    this.lastActiveAt = now;
    this._markDirty('devices');
    this.broadcastDevices();
  }

  deviceDisconnected(socketId, deviceId) {
    const sockets = this.connections.get(deviceId);
    if (!sockets) return;
    sockets.delete(socketId);
    const device = this.devices.get(deviceId);
    if (device) device.lastSeen = Date.now();
    if (sockets.size === 0) {
      this.connections.delete(deviceId);
      const timer = setTimeout(() => {
        this.offlineTimers.delete(deviceId);
        if (!this.isOnline(deviceId)) {
          const d = this.devices.get(deviceId);
          this.addActivity({ type: 'device-offline', deviceId, deviceName: d ? d.name : 'Unknown device' });
        }
      }, this.config.offlineGraceMs);
      timer.unref();
      this.offlineTimers.set(deviceId, timer);
    }
    this.lastActiveAt = Date.now();
    this._markDirty('devices');
    this.broadcastDevices();
  }

  renameDevice(deviceId, name) {
    const device = this.devices.get(deviceId);
    if (!device) throw new SyncError('NOT_FOUND', 'Device not found.');
    const previousName = device.name;
    if (previousName === name) return device;
    device.name = name;
    this._markDirty('devices');
    this.addActivity({ type: 'device-renamed', deviceId, deviceName: name, detail: previousName });
    this.broadcastDevices();
    return device;
  }

  removeDevice(deviceId) {
    if (!this.devices.has(deviceId)) throw new SyncError('NOT_FOUND', 'Device not found.');
    if (this.isOnline(deviceId)) throw new SyncError('DEVICE_ONLINE', 'Only offline devices can be removed.');
    const device = this.devices.get(deviceId);
    this.devices.delete(deviceId);
    this._markDirty('devices');
    this.addActivity({ type: 'device-removed', deviceId, deviceName: device.name });
    this.broadcastDevices();
  }

  markSynced(deviceId) {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.lastSync = Date.now();
    this._markDirty('devices');
    this.broadcastDevices();
  }

  // ---------------------------------------------------------------------------
  // Activity log
  // ---------------------------------------------------------------------------

  addActivity({ type, path, size, deviceId, deviceName, detail }) {
    const entry = { id: randomId(), ts: Date.now(), type, deviceId: deviceId || null, deviceName: deviceName || null };
    if (path !== undefined) entry.path = path;
    if (size !== undefined) entry.size = size;
    if (detail !== undefined) entry.detail = detail;
    this.activity.push(entry);
    if (this.activity.length > this.config.activityLimit) {
      this.activity.splice(0, this.activity.length - this.config.activityLimit);
    }
    this._markDirty('activity');
    this.broadcast('activity:new', entry);
    return entry;
  }

  recentActivity(limit = 100) {
    return this.activity.slice(-limit);
  }

  destroy() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const timer of this.offlineTimers.values()) clearTimeout(timer);
    this.offlineTimers.clear();
  }
}

/** Lazily loads workspaces on first use and evicts idle ones to keep memory low. */
class WorkspaceManager {
  constructor({ storage, config, io }) {
    this.storage = storage;
    this.config = config;
    this.io = io;
    this.workspaces = new Map();
    this.loading = new Map();
    this.sweeper = setInterval(() => this.sweep(), 60 * 1000);
    this.sweeper.unref();
  }

  async get(code) {
    const existing = this.workspaces.get(code);
    if (existing) {
      existing.lastActiveAt = Date.now();
      return existing;
    }
    let pending = this.loading.get(code);
    if (!pending) {
      pending = (async () => {
        const ws = new Workspace({
          code,
          storage: this.storage,
          config: this.config,
          broadcast: (event, data) => this.io.to(`ws:${code}`).emit(event, data),
        });
        await ws.load();
        this.workspaces.set(code, ws);
        return ws;
      })().finally(() => this.loading.delete(code));
      this.loading.set(code, pending);
    }
    return pending;
  }

  sweep() {
    const now = Date.now();
    for (const [code, ws] of this.workspaces) {
      if (ws.connections.size === 0 && now - ws.lastActiveAt > this.config.workspaceIdleMs && !ws.indexing) {
        ws.flush()
          .then(() => {
            if (ws.connections.size === 0 && this.workspaces.get(code) === ws) {
              ws.destroy();
              this.workspaces.delete(code);
              log.info(`[${code}] idle workspace evicted from memory`);
            }
          })
          .catch((err) => log.warn(`[${code}] could not flush idle workspace`, err));
      } else if (ws.connections.size > 0 && ws.indexBuiltAt && now - ws.indexBuiltAt > this.config.indexMaxAgeMs) {
        ws.rebuildIndex().catch((err) => log.warn(`[${code}] periodic re-index failed`, err));
      }
    }
  }

  async flushAll() {
    clearInterval(this.sweeper);
    await Promise.allSettled([...this.workspaces.values()].map((ws) => ws.flush()));
  }

  stats() {
    let devicesOnline = 0;
    for (const ws of this.workspaces.values()) devicesOnline += ws.connections.size;
    return { workspaces: this.workspaces.size, devicesOnline };
  }
}

module.exports = { Workspace, WorkspaceManager, publicFile };
