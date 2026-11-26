'use strict';

const { EventEmitter } = require('node:events');
const { CloudClient } = require('./cloud-client');
const { SyncEngine } = require('./sync-engine');
const { SyncState } = require('./sync-state');

/** Safety net: rescan everything periodically in case a watcher event was missed. */
const PERIODIC_RESCAN_MS = 10 * 60 * 1000;
const SYNC_REPORT_MIN_INTERVAL_MS = 10 * 1000;
const ACTIVITY_LIMIT = 250;
const LOCAL_ACTIVITY_LIMIT = 100;

/**
 * One connection to one workspace (server URL + Server Code) syncing one folder.
 * Electron-agnostic: everything platform specific (trash, logging) is injected.
 */
class SyncSession extends EventEmitter {
  constructor({ serverUrl, serverCode, deviceId, deviceName, syncFolder, stateDir, appVersion, platform, trash, logger }) {
    super();
    this.serverUrl = serverUrl;
    this.serverCode = serverCode;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.syncFolder = syncFolder;
    this.stateDir = stateDir;
    this.appVersion = appVersion;
    this.platform = platform;
    this.trash = trash;
    this.log = logger || console;

    this.client = null;
    this.engine = null;
    this.devices = [];
    this.activity = [];
    this.localActivity = [];
    this.serverVersion = null;
    this.rescanTimer = null;
    this.lastSyncReport = 0;
    this.syncReportTimer = null;
    this.stopped = false;
  }

  async start() {
    const client = new CloudClient({
      serverUrl: this.serverUrl,
      serverCode: this.serverCode,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      platform: this.platform,
      appVersion: this.appVersion,
    });
    this.client = client;

    client.on('status', (status) => {
      this.emit('connection', status);
      if (this.engine) this.emit('sync', this.engine.getStatus());
    });
    client.on('ready', (data) => this._onReady(data));
    client.on('disconnected', (reason) => this.log.info(`[session] disconnected: ${reason}`));
    client.on('connect-error', (err) => this.log.warn(`[session] connection error: ${err.message}`));
    client.on('devices:update', (payload) => {
      this.devices = Array.isArray(payload && payload.devices) ? payload.devices : [];
      this.emit('devices', this.devices);
    });
    client.on('activity:new', (entry) => {
      if (!entry || !entry.id) return;
      this.activity.push(entry);
      if (this.activity.length > ACTIVITY_LIMIT) this.activity.splice(0, this.activity.length - ACTIVITY_LIMIT);
      this.emit('activity:new', entry);
    });
    for (const event of ['file:added', 'file:updated', 'file:deleted']) {
      client.on(event, (payload) => {
        if (this.engine) this.engine.handleRemoteEvent(event, payload);
      });
    }

    await this._startEngine(this.syncFolder);
    client.start();
    this.rescanTimer = setInterval(() => {
      if (this.engine && this.client.connected) this.engine.fullSync('periodic');
    }, PERIODIC_RESCAN_MS);
  }

  async _startEngine(folder) {
    const state = await new SyncState({ dir: this.stateDir, serverCode: this.serverCode, root: folder }).load();
    const engine = new SyncEngine({
      root: folder,
      client: this.client,
      state,
      deviceName: this.deviceName,
      trash: this.trash,
      logger: this.log,
      platform: this.platform,
    });
    engine.on('status', (status) => this.emit('sync', status));
    engine.on('files', () => this.emit('files'));
    engine.on('notice', (notice) => this._notice(notice));
    engine.on('idle', () => this._reportSynced());
    await engine.start();
    this.engine = engine;
    this.syncFolder = folder;
    if (this.client.connected) engine.fullSync('folder changed');
  }

  _onReady(data) {
    this.serverVersion = data.serverVersion || null;
    this.devices = Array.isArray(data.devices) ? data.devices : [];
    this.activity = Array.isArray(data.activity) ? data.activity.slice(-ACTIVITY_LIMIT) : [];
    this.log.info(`[session] connected to ${this.serverUrl} (server v${this.serverVersion}, workspace ${this.serverCode})`);
    this.emit('devices', this.devices);
    this.emit('activity', this.getActivity());
    this.emit('ready', data);
    if (this.engine) this.engine.fullSync('connected');
  }

  _notice(notice) {
    const entry = {
      id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      type: notice.level === 'error' ? 'local-error' : 'local-warning',
      path: notice.path,
      detail: notice.message,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      local: true,
    };
    this.localActivity.push(entry);
    if (this.localActivity.length > LOCAL_ACTIVITY_LIMIT) this.localActivity.shift();
    this.emit('activity:new', entry);
    this.emit('notice', notice);
  }

  /** Tell the server this device is fully in sync (drives "Last sync" in the device list). */
  _reportSynced() {
    if (this.syncReportTimer) return;
    const wait = Math.max(0, this.lastSyncReport + SYNC_REPORT_MIN_INTERVAL_MS - Date.now());
    this.syncReportTimer = setTimeout(() => {
      this.syncReportTimer = null;
      this.lastSyncReport = Date.now();
      if (this.client && this.client.connected) this.client.request('device:sync-report', {}).catch(() => {});
    }, wait);
  }

  /** Resolves once the workspace session is ready, or with an error for permanent failures / timeout. */
  waitForConnection(timeoutMs = 30000) {
    if (this.client.connected) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        this.client.off('ready', onReady);
        this.client.off('connect-error', onError);
        resolve(result);
      };
      const onReady = () => finish({ ok: true });
      const onError = (err) => {
        if (err.permanent) finish({ ok: false, permanent: true, error: err.message });
      };
      const timer = setTimeout(
        () => finish({ ok: false, timeout: true, error: this.client.lastError ? this.client.lastError.message : 'Timed out' }),
        timeoutMs,
      );
      this.client.on('ready', onReady);
      this.client.on('connect-error', onError);
    });
  }

  async renameDevice(name) {
    this.deviceName = name;
    this.client.setDeviceName(name); // also used for every future reconnect
    if (this.engine) this.engine.deviceName = name;
    if (!this.client.connected) return { offline: true };
    const res = await this.client.request('device:rename', { name });
    this.devices = res.devices || this.devices;
    this.emit('devices', this.devices);
    return { offline: false };
  }

  async removeDevice(deviceId) {
    const res = await this.client.request('device:remove', { deviceId });
    this.devices = res.devices || this.devices;
    this.emit('devices', this.devices);
  }

  async changeFolder(folder) {
    const previous = this.engine;
    this.engine = null;
    if (previous) await previous.stop();
    await this._startEngine(folder);
    this.emit('sync', this.engine.getStatus());
    this.emit('files');
  }

  syncNow() {
    if (!this.client.connected) {
      this.client.reconnectNow();
      return;
    }
    if (this.engine) this.engine.fullSync('manual');
  }

  getActivity() {
    return [...this.activity, ...this.localActivity].sort((a, b) => a.ts - b.ts).slice(-ACTIVITY_LIMIT);
  }

  snapshot() {
    return {
      serverUrl: this.serverUrl,
      serverCode: this.serverCode,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      syncFolder: this.syncFolder,
      serverVersion: this.serverVersion,
      connection: this.client ? this.client.getStatus() : { status: 'idle' },
      devices: this.devices,
      activity: this.getActivity(),
      files: this.engine ? this.engine.listFiles() : [],
      sync: this.engine ? this.engine.getStatus() : null,
    };
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.rescanTimer);
    clearTimeout(this.syncReportTimer);
    if (this.client) this.client.stop();
    if (this.engine) await this.engine.stop();
    this.removeAllListeners();
  }
}

module.exports = { SyncSession };
