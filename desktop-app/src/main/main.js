'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
} = require('electron');

const { ConfigStore } = require('./config-store');
const { SyncSession } = require('./session');
const { normalizeServerUrl } = require('./cloud-client');
const { createLogger } = require('./logger');

const APP_ID = 'com.companysync.desktop';
const APP_NAME = 'CompanySync';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SERVER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

let config = null;
let log = console;
let mainWindow = null;
let tray = null;
let trayLabel = '';
let session = null;
let sessionParams = null; // credentials of the running session (also when "remember" is off)
let isQuitting = false;
let quitCleanupDone = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultFolder() {
  return path.join(app.getPath('documents'), APP_NAME);
}

function cleanDeviceName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 64);
}

function defaultDeviceName() {
  return cleanDeviceName(os.hostname().replace(/\.local$/i, '')) || 'My Computer';
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow(true);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function currentFolder() {
  return (session && session.syncFolder) || config.get().syncFolder || defaultFolder();
}

function buildState() {
  const c = config.get();
  return {
    view: session ? 'dashboard' : 'login',
    appVersion: app.getVersion(),
    platform: process.platform,
    canLaunchAtLogin: process.platform === 'win32' || process.platform === 'darwin',
    config: {
      serverUrl: (sessionParams && sessionParams.serverUrl) || c.serverUrl,
      serverCode: (sessionParams && sessionParams.serverCode) || c.serverCode,
      deviceName: c.deviceName,
      deviceId: c.deviceId,
      remember: c.remember,
      syncFolder: c.syncFolder || defaultFolder(),
      defaultFolder: defaultFolder(),
      theme: c.theme,
      launchAtLogin: c.launchAtLogin,
      logFile: log.file || null,
    },
    session: session ? session.snapshot() : null,
  };
}

function describeStatus() {
  if (!session) return 'Not connected';
  const conn = session.client ? session.client.status : 'idle';
  if (conn !== 'connected') return conn === 'error' ? 'Connection refused' : 'Reconnecting…';
  const s = session.engine ? session.engine.getStatus() : null;
  if (!s) return 'Starting…';
  switch (s.state) {
    case 'idle':
      return 'Up to date';
    case 'scanning':
      return 'Checking for changes…';
    case 'syncing':
      return `Syncing ${s.pending} item${s.pending === 1 ? '' : 's'}…`;
    case 'error':
      return `${s.errorCount} item${s.errorCount === 1 ? '' : 's'} could not sync`;
    case 'offline':
      return 'Offline';
    default:
      return 'Starting…';
  }
}

function friendlyNetworkError(err, serverUrl) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return `The server at ${serverUrl} did not respond. Free servers can take up to a minute to wake up — please try again.`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The address ${serverUrl} could not be found. Check the Server URL.`;
  if (code === 'ECONNREFUSED') return `Nothing is listening at ${serverUrl}. Check the Server URL.`;
  if (/CERT|SSL|TLS/i.test(code)) return `Secure connection to ${serverUrl} failed (${code}). Check the domain's SSL setup.`;
  return `Could not reach ${serverUrl}: ${err && err.message ? err.message : 'unknown error'}`;
}

async function checkHealth(serverUrl, timeoutMs = 75000) {
  let res;
  try {
    res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch (err) {
    throw new Error(friendlyNetworkError(err, serverUrl));
  }
  if (!res.ok) throw new Error(`The server at ${serverUrl} answered with HTTP ${res.status}. Is this a CompanySync server?`);
}

async function confirm(message, detail, confirmLabel = 'Continue', destructive = false) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: destructive ? 'warning' : 'question',
    buttons: [confirmLabel, 'Cancel'],
    defaultId: destructive ? 1 : 0,
    cancelId: 1,
    message,
    detail,
    noLink: true,
  });
  return response === 0;
}

// ---------------------------------------------------------------------------
// Sync session lifecycle
// ---------------------------------------------------------------------------

async function startSession({ serverUrl, serverCode }) {
  const c = config.get();
  const folder = c.syncFolder || defaultFolder();
  const next = new SyncSession({
    serverUrl,
    serverCode,
    deviceId: c.deviceId,
    deviceName: c.deviceName || defaultDeviceName(),
    syncFolder: folder,
    stateDir: path.join(app.getPath('userData'), 'sync-state'),
    appVersion: app.getVersion(),
    platform: process.platform,
    trash: (abs) => shell.trashItem(abs),
    logger: log,
  });

  next.on('connection', (status) => {
    send('connection', status);
    updateTray();
  });
  next.on('sync', (status) => {
    send('sync', status);
    updateTray();
  });
  next.on('files', () => {
    if (next.engine) send('files', next.engine.listFiles());
  });
  next.on('devices', (devices) => send('devices', devices));
  next.on('activity', (entries) => send('activity', entries));
  next.on('activity:new', (entry) => send('activity:new', entry));
  next.on('notice', (notice) => {
    send('notice', notice);
    const hidden = !mainWindow || !mainWindow.isVisible();
    if (hidden && notice.level === 'warn' && Notification.isSupported()) {
      new Notification({ title: APP_NAME, body: notice.message, silent: true }).show();
    }
  });

  session = next;
  sessionParams = { serverUrl, serverCode };
  try {
    await next.start();
  } catch (err) {
    session = null;
    sessionParams = null;
    await next.stop().catch(() => {});
    throw err;
  }
  updateTray();
  return next;
}

async function stopSession() {
  const current = session;
  session = null;
  sessionParams = null;
  if (current) await current.stop().catch((err) => log.warn('Error while stopping session', err));
  updateTray();
}

// ---------------------------------------------------------------------------
// Window, tray and menu
// ---------------------------------------------------------------------------

function createWindow(forceShow = false) {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e131d' : '#f4f6fa',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!startHidden || forceShow) mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    // While syncing, closing the window only hides it: sync keeps running in the tray.
    if (isQuitting || !session) return;
    event.preventDefault();
    mainWindow.hide();
    const c = config.get();
    if (!c.trayHintShown && Notification.isSupported()) {
      new Notification({
        title: `${APP_NAME} is still syncing`,
        body: 'The app keeps running in the system tray. Use the tray icon to open it or quit.',
        silent: true,
      }).show();
      config.update({ trayHintShown: true });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(process.platform === 'win32' ? icon : icon.resize({ width: 16, height: 16 }));
  tray.on('click', () => {
    if (process.platform !== 'darwin') showWindow();
  });
  tray.on('double-click', showWindow);
  updateTray(true);
}

function updateTray(force = false) {
  if (!tray) return;
  const label = describeStatus();
  if (!force && label === trayLabel) return;
  trayLabel = label;
  const c = config.get();
  const template = [
    { label: `Open ${APP_NAME}`, click: showWindow },
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open Sync Folder', click: () => shell.openPath(currentFolder()) },
    { label: 'Sync Now', enabled: Boolean(session), click: () => session && session.syncNow() },
    { type: 'separator' },
  ];
  if (process.platform === 'win32' || process.platform === 'darwin') {
    template.push({
      label: 'Launch at Login',
      type: 'checkbox',
      checked: Boolean(c.launchAtLogin),
      click: (item) => setLaunchAtLogin(item.checked),
    });
    template.push({ type: 'separator' });
  }
  template.push({ label: `Quit ${APP_NAME}`, click: quitApp });
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`${APP_NAME} — ${label}`);
}

function setApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs an Edit menu for copy/paste shortcuts to work in text fields.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
      { role: 'windowMenu' },
    ]),
  );
}

function setLaunchAtLogin(enabled) {
  config.update({ launchAtLogin: Boolean(enabled) });
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] });
  }
  updateTray(true);
  send('config', buildState().config);
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function requireSession() {
  if (!session || !session.engine) throw new Error('Not connected to a server.');
  return session;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const result = await fn(...args);
      return { ok: true, ...(result || {}) };
    } catch (err) {
      log.warn(`[ipc] ${channel} failed: ${err.message}`);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function registerIpc() {
  handle('app:get-state', async () => ({ state: buildState() }));

  handle('session:connect', async (input = {}) => {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const serverCode = String(input.serverCode || '').trim();
    if (!SERVER_CODE_RE.test(serverCode)) {
      throw new Error('Server Code must be 3-64 characters: letters, numbers, "-" or "_".');
    }
    const deviceName = cleanDeviceName(input.deviceName);
    if (!deviceName) throw new Error('Enter a name for this device.');
    const syncFolder = path.resolve(String(input.syncFolder || config.get().syncFolder || defaultFolder()));
    const remember = Boolean(input.remember);

    send('connect-progress', 'Contacting the server… (a sleeping free-tier server can take up to a minute to wake up)');
    await checkHealth(serverUrl);

    send('connect-progress', 'Opening the sync channel…');
    await stopSession();
    config.update({ deviceName, syncFolder, remember, autoConnect: remember, serverUrl, serverCode });
    await startSession({ serverUrl, serverCode });
    const result = await session.waitForConnection(30000);
    if (!result.ok && result.permanent) {
      await stopSession();
      config.update({ autoConnect: false });
      throw new Error(result.error);
    }
    send('view', buildState());
    return {
      warning: result.ok ? null : 'The server is reachable but the sync channel is still starting. The app keeps retrying automatically.',
    };
  });

  handle('session:disconnect', async () => {
    const ok = await confirm(
      'Disconnect from this server?',
      'Syncing stops until you connect again. Files already in your sync folder stay on this computer.',
      'Disconnect',
    );
    if (!ok) return { cancelled: true };
    await stopSession();
    config.update({ autoConnect: false });
    send('view', buildState());
    return {};
  });

  handle('session:sync-now', async () => {
    requireSession().syncNow();
    return {};
  });

  handle('device:rename', async (name) => {
    const clean = cleanDeviceName(name);
    if (!clean) throw new Error('Device name cannot be empty.');
    config.update({ deviceName: clean });
    let offline = false;
    if (session) offline = (await session.renameDevice(clean)).offline;
    send('config', buildState().config);
    return { deviceName: clean, offline };
  });

  handle('device:remove', async ({ deviceId, name } = {}) => {
    const ok = await confirm(
      `Remove "${name || 'this device'}" from the device list?`,
      'It reappears automatically if that computer connects again.',
      'Remove',
      true,
    );
    if (!ok) return { cancelled: true };
    await requireSession().removeDevice(deviceId);
    return {};
  });

  handle('folder:open', async () => {
    const folder = currentFolder();
    fs.mkdirSync(folder, { recursive: true });
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
    return {};
  });

  handle('folder:choose', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the folder to sync',
      defaultPath: config.get().syncFolder || defaultFolder(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (canceled || !filePaths.length) return { cancelled: true };
    return { folder: filePaths[0] };
  });

  handle('folder:change', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a new folder to sync',
      defaultPath: currentFolder(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (canceled || !filePaths.length) return { cancelled: true };
    const folder = path.resolve(filePaths[0]);
    if (folder === currentFolder()) return { folder };
    if (folder === path.parse(folder).root) throw new Error('Choose a folder, not the root of a drive.');
    if (folder.startsWith(app.getPath('userData'))) throw new Error('This folder is used internally by the app.');
    if (session) {
      const ok = await confirm(
        `Sync "${folder}" instead?`,
        'All workspace files will be downloaded into the new folder and files already in it will be uploaded. The old folder is left untouched.',
        'Change Folder',
      );
      if (!ok) return { cancelled: true };
    }
    config.update({ syncFolder: folder });
    if (session) await session.changeFolder(folder);
    send('config', buildState().config);
    return { folder };
  });

  handle('file:open', async (rel) => {
    const s = requireSession();
    if (!(await s.engine.isAvailableLocally(rel))) throw new Error('This file has not been downloaded to this computer yet.');
    const error = await shell.openPath(s.engine.localPath(rel));
    if (error) throw new Error(error);
    return {};
  });

  handle('file:show', async (rel) => {
    const s = requireSession();
    if (await s.engine.isAvailableLocally(rel)) shell.showItemInFolder(s.engine.localPath(rel));
    else await shell.openPath(s.syncFolder);
    return {};
  });

  handle('file:save-as', async (rel) => {
    const s = requireSession();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save a copy',
      defaultPath: path.join(app.getPath('downloads'), path.posix.basename(rel)),
    });
    if (canceled || !filePath) return { cancelled: true };
    await s.engine.saveRemoteCopy(rel, filePath);
    return { savedTo: filePath };
  });

  handle('file:delete', async ({ path: rel, isFolder } = {}) => {
    const s = requireSession();
    const targets = isFolder ? s.engine.filesUnder(rel) : [rel];
    if (!targets.length) return { deleted: 0 };
    const ok = await confirm(
      isFolder ? `Delete the folder "${rel}" and its ${targets.length} file(s)?` : `Delete "${path.posix.basename(rel)}"?`,
      'It is removed from the cloud and from every connected device. Local copies are moved to the Recycle Bin / Trash.',
      'Delete',
      true,
    );
    if (!ok) return { cancelled: true };
    let deleted = 0;
    for (const target of targets) {
      await s.engine.deleteRemoteFile(target);
      deleted++;
    }
    return { deleted };
  });

  handle('files:import', async ({ paths, targetDir } = {}) => {
    const s = requireSession();
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p);
    if (!list.length) throw new Error('Nothing to upload.');
    const count = await s.engine.importPaths(list, targetDir || '');
    return { count };
  });

  handle('files:pick-and-import', async (targetDir) => {
    const s = requireSession();
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Upload files',
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled || !filePaths.length) return { cancelled: true };
    const count = await s.engine.importPaths(filePaths, targetDir || '');
    return { count };
  });

  handle('prefs:set', async (prefs = {}) => {
    if (prefs.theme && ['system', 'light', 'dark'].includes(prefs.theme)) {
      config.update({ theme: prefs.theme });
      nativeTheme.themeSource = prefs.theme;
    }
    if (typeof prefs.launchAtLogin === 'boolean') setLaunchAtLogin(prefs.launchAtLogin);
    return { config: buildState().config };
  });

  handle('app:open-logs', async () => {
    if (log.file) shell.showItemInFolder(log.file);
    return {};
  });
}

// ---------------------------------------------------------------------------
// App bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  log = createLogger(path.join(app.getPath('userData'), 'logs'), { verbose: isDev });
  config = new ConfigStore(path.join(app.getPath('userData'), 'config.json'));
  const c = config.get();
  const patch = {};
  if (!c.deviceId) patch.deviceId = crypto.randomUUID();
  if (!c.deviceName) patch.deviceName = defaultDeviceName();
  if (!c.syncFolder) patch.syncFolder = defaultFolder();
  if (Object.keys(patch).length) config.update(patch);

  log.info(`${APP_NAME} ${app.getVersion()} starting (${process.platform}, Electron ${process.versions.electron})`);
  nativeTheme.themeSource = config.get().theme || 'system';

  setApplicationMenu();
  registerIpc();
  createWindow();
  createTray();

  const saved = config.get();
  if (saved.remember && saved.autoConnect && saved.serverUrl && saved.serverCode) {
    // Auto-connect without waiting for the network: the client retries forever, so the
    // app also starts fine offline or while the server is waking up.
    startSession({ serverUrl: saved.serverUrl, serverCode: saved.serverCode })
      .then(() => send('view', buildState()))
      .catch((err) => {
        log.error('Auto-connect failed', err);
        send('notice', { level: 'error', message: `Could not start syncing: ${err.message}` });
      });
  }

  powerMonitor.on('resume', () => {
    log.info('System resumed from sleep; reconnecting');
    if (session && session.client) session.client.reconnectNow();
  });

  nativeTheme.on('updated', () => send('theme-updated', nativeTheme.shouldUseDarkColors));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);

  app.on('second-instance', () => showWindow());

  app.whenReady().then(bootstrap).catch((err) => {
    console.error(err);
    dialog.showErrorBox(APP_NAME, `The app could not start:\n${err.stack || err.message}`);
    app.exit(1);
  });

  app.on('activate', () => showWindow());

  app.on('before-quit', (event) => {
    isQuitting = true;
    if (quitCleanupDone || !session) return;
    // Flush sync state and stop transfers cleanly before exiting.
    event.preventDefault();
    quitCleanupDone = true;
    stopSession().finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    // Without an active session there is nothing to keep running in the background.
    if (!session) app.quit();
  });
}
