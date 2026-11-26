'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set([
  'view',
  'config',
  'connection',
  'sync',
  'files',
  'devices',
  'activity',
  'activity:new',
  'notice',
  'connect-progress',
  'theme-updated',
  'confirm',
]);

/**
 * The only bridge between the sandboxed UI and the main process. The renderer never
 * gets Node.js access; it can call these whitelisted actions and subscribe to events.
 */
contextBridge.exposeInMainWorld('companySync', {
  getState: () => ipcRenderer.invoke('app:get-state'),
  connect: (options) => ipcRenderer.invoke('session:connect', options),
  disconnect: () => ipcRenderer.invoke('session:disconnect'),
  syncNow: () => ipcRenderer.invoke('session:sync-now'),
  renameDevice: (name) => ipcRenderer.invoke('device:rename', name),
  removeDevice: (deviceId, name) => ipcRenderer.invoke('device:remove', { deviceId, name }),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  changeFolder: () => ipcRenderer.invoke('folder:change'),
  openFile: (rel) => ipcRenderer.invoke('file:open', rel),
  showFile: (rel) => ipcRenderer.invoke('file:show', rel),
  saveFileAs: (rel) => ipcRenderer.invoke('file:save-as', rel),
  deleteFile: (rel, isFolder = false) => ipcRenderer.invoke('file:delete', { path: rel, isFolder }),
  importPaths: (paths, targetDir) => ipcRenderer.invoke('files:import', { paths, targetDir }),
  pickAndImport: (targetDir) => ipcRenderer.invoke('files:pick-and-import', targetDir),
  setPreferences: (prefs) => ipcRenderer.invoke('prefs:set', prefs),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  /** Answer a confirmation request that the main process sent through the 'confirm' event. */
  respondConfirm: (id, ok) => ipcRenderer.send('confirm:response', { id, ok: Boolean(ok) }),
  /** Absolute path of a dropped File (File.path no longer exists in modern Electron). */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  on: (channel, callback) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown event: ${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
