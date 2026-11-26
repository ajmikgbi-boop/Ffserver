'use strict';

const fs = require('node:fs');
const { writeJsonAtomicSync } = require('./fs-utils');

const DEFAULTS = Object.freeze({
  version: 1,
  serverUrl: '',
  serverCode: '',
  deviceName: '',
  deviceId: '',
  remember: true,
  autoConnect: false,
  syncFolder: '',
  theme: 'system', // system | light | dark
  launchAtLogin: false,
  trayHintShown: false,
});

/**
 * Persists app settings to `app.getPath('userData')/config.json`.
 * When "Remember this server" is off, the server URL and code are never written.
 */
class ConfigStore {
  constructor(file) {
    this.file = file;
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      stored = {};
    }
    this.data = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  }

  get() {
    return { ...this.data };
  }

  update(patch) {
    this.data = { ...this.data, ...patch };
    if (!this.data.remember) {
      this.data.serverUrl = '';
      this.data.serverCode = '';
      this.data.autoConnect = false;
    }
    writeJsonAtomicSync(this.file, this.data);
    return this.get();
  }
}

module.exports = { ConfigStore, DEFAULTS };
