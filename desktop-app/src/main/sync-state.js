'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJsonAtomic } = require('./fs-utils');

const STATE_VERSION = 1;

/**
 * The "base" of the three-way sync: for every path, the SHA-256 (plus size/mtime) of
 * the version that was last known to be identical locally and in the cloud.
 *
 * It lets the engine tell "deleted here" from "created there", and "changed here"
 * from "changed there", even after the app was closed for weeks. One state file
 * exists per (Server Code, sync folder) pair, so switching either starts clean.
 */
class SyncState {
  constructor({ dir, serverCode, root }) {
    const key = crypto.createHash('sha1').update(`${serverCode}\n${path.resolve(root)}`).digest('hex').slice(0, 16);
    this.file = path.join(dir, `state-${key}.json`);
    this.serverCode = serverCode;
    this.root = root;
    this.entries = new Map();
    this.saveTimer = null;
    this.saving = null;
    this.dirty = false;
  }

  async load() {
    const doc = await readJson(this.file, null);
    this.entries.clear();
    if (doc && doc.version === STATE_VERSION && doc.entries && typeof doc.entries === 'object') {
      for (const [rel, value] of Object.entries(doc.entries)) {
        if (Array.isArray(value) && typeof value[0] === 'string') {
          this.entries.set(rel, { sha256: value[0], size: Number(value[1]) || 0, mtimeMs: Number(value[2]) || 0 });
        }
      }
    }
    return this;
  }

  get size() {
    return this.entries.size;
  }

  get(rel) {
    return this.entries.get(rel) || null;
  }

  has(rel) {
    return this.entries.has(rel);
  }

  keys() {
    return this.entries.keys();
  }

  set(rel, { sha256, size, mtimeMs }) {
    this.entries.set(rel, { sha256, size, mtimeMs });
    this._scheduleSave();
  }

  delete(rel) {
    if (this.entries.delete(rel)) this._scheduleSave();
  }

  clear() {
    this.entries.clear();
    this._scheduleSave();
  }

  _scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch(() => this._scheduleSave());
    }, 1000);
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.saving) await this.saving.catch(() => {});
    if (!this.dirty) return;
    this.dirty = false;
    const entries = {};
    for (const [rel, e] of this.entries) entries[rel] = [e.sha256, e.size, e.mtimeMs];
    this.saving = writeJsonAtomic(this.file, {
      version: STATE_VERSION,
      serverCode: this.serverCode,
      root: this.root,
      savedAt: new Date().toISOString(),
      entries,
    })
      .catch((err) => {
        this.dirty = true;
        throw err;
      })
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }
}

module.exports = { SyncState };
