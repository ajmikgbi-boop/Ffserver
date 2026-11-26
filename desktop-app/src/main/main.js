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
const { S, translateError, PLATFORM_NAMES, SERVER_ERRORS } = require('./i18n');

const APP_ID = 'com.companysync.desktop';
const APP_NAME = 'CompanySync';
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const SERVER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const isDev = process.argv.includes('--dev');
const startHidden = process.argv.includes('--hidden');

// The whole UI is Arabic: make Chromium (Intl defaults, navigator.language) agree.
app.commandLine.appendSwitch('lang', 'ar');

let config = null;
let log = console;
let mainWindow = null;
let tray = null;
let trayLabel = '';
let session = null;
let sessionParams = null; // credentials of the running session (also when "remember" is off)
let isQuitting = false;
let quitCleanupDone = false;
const pendingConfirms = new Map(); // id -> resolve(boolean) for in-app confirmation dialogs

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
  return cleanDeviceName(os.hostname().replace(/\.local$/i, '')) || 'جهازي';
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
    platformName: PLATFORM_NAMES[process.platform] || process.platform,
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
  if (!session) return S.status.notConnected;
  const conn = session.client ? session.client.status : 'idle';
  if (conn !== 'connected') return conn === 'error' ? S.status.refused : S.status.reconnecting;
  const s = session.engine ? session.engine.getStatus() : null;
  if (!s) return S.status.starting;
  switch (s.state) {
    case 'idle':
      return S.status.upToDate;
    case 'scanning':
      return S.status.scanning;
    case 'syncing':
      return S.status.syncing(s.pending);
    case 'error':
      return S.status.failed(s.errorCount);
    case 'offline':
      return S.status.offline;
    default:
      return S.status.starting;
  }
}

function friendlyNetworkError(err, serverUrl) {
  const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return S.connect.timeout(serverUrl);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return S.connect.notFound(serverUrl);
  if (code === 'ECONNREFUSED') return S.connect.refused(serverUrl);
  if (/CERT|SSL|TLS/i.test(code)) return S.connect.tls(serverUrl, code);
  return S.connect.unreachable(serverUrl, translateError(err && err.cause ? err.cause : err));
}

async function checkHealth(serverUrl, timeoutMs = 75000) {
  let res;
  try {
    res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
  } catch (err) {
    throw new Error(friendlyNetworkError(err, serverUrl));
  }
  if (!res.ok) throw new Error(S.connect.badStatus(serverUrl, res.status));
}

/**
 * Ask the user to confirm an action with the app's own right-to-left modal (native
 * message boxes follow the OS layout direction, which is wrong on non-Arabic Windows).
 * Falls back to a native dialog only when no window is available.
 */
async function confirm(message, detail, confirmLabel, destructive = false) {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    const { response } = await dialog.showMessageBox({
      type: destructive ? 'warning' : 'question',
      buttons: [confirmLabel, S.dialogs.cancel],
      defaultId: destructive ? 1 : 0,
      cancelId: 1,
      message,
      detail,
      noLink: true,
    });
    return response === 0;
  }
  showWindow();
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingConfirms.set(id, resolve);
    send('confirm', { id, message, detail, confirmLabel, cancelLabel: S.dialogs.cancel, destructive });
  });
}

function resolvePendingConfirms(value) {
  for (const resolve of pendingConfirms.values()) resolve(value);
  pendingConfirms.clear();
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
        title: S.tray.keepsRunningTitle,
        body: S.tray.keepsRunningBody,
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
  // A reloaded or crashed renderer can no longer answer open confirmations.
  mainWindow.webContents.on('did-start-loading', () => resolvePendingConfirms(false));
  mainWindow.webContents.on('render-process-gone', () => resolvePendingConfirms(false));
  mainWindow.on('closed', () => resolvePendingConfirms(false));
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
    { label: S.tray.open, click: showWindow },
    { label, enabled: false },
    { type: 'separator' },
    { label: S.tray.openFolder, click: () => shell.openPath(currentFolder()) },
    { label: S.tray.syncNow, enabled: Boolean(session), click: () => session && session.syncNow() },
    { type: 'separator' },
  ];
  if (process.platform === 'win32' || process.platform === 'darwin') {
    template.push({
      label: S.tray.launchAtLogin,
      type: 'checkbox',
      checked: Boolean(c.launchAtLogin),
      click: (item) => setLaunchAtLogin(item.checked),
    });
    template.push({ type: 'separator' });
  }
  template.push({ label: S.tray.quit, click: quitApp });
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(S.tray.tooltip(label));
}

function setApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS needs an Edit menu for copy/paste shortcuts to work in text fields.
  // Items are spelled out so every label is Arabic.
  const m = S.macMenu;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_NAME,
        submenu: [
          { role: 'about', label: m.about },
          { type: 'separator' },
          { role: 'hide', label: m.hide },
          { role: 'hideOthers', label: m.hideOthers },
          { role: 'unhide', label: m.showAll },
          { type: 'separator' },
          { role: 'quit', label: m.quit },
        ],
      },
      {
        label: m.edit,
        submenu: [
          { role: 'undo', label: m.undo },
          { role: 'redo', label: m.redo },
          { type: 'separator' },
          { role: 'cut', label: m.cut },
          { role: 'copy', label: m.copy },
          { role: 'paste', label: m.paste },
          { role: 'selectAll', label: m.selectAll },
        ],
      },
      {
        label: m.view,
        submenu: [
          { role: 'reload', label: m.reload },
          { role: 'toggleDevTools', label: m.devTools },
          { type: 'separator' },
          { role: 'togglefullscreen', label: m.fullscreen },
        ],
      },
      {
        label: m.window,
        submenu: [
          { role: 'minimize', label: m.minimize },
          { role: 'zoom', label: m.zoom },
          { role: 'close', label: m.close },
        ],
      },
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
  if (!session || !session.engine) throw new Error(S.errors.notConnected);
  return session;
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const result = await fn(...args);
      return { ok: true, ...(result || {}) };
    } catch (err) {
      log.warn(`[ipc] ${channel} failed: ${err.message}`);
      return { ok: false, error: translateError(err) };
    }
  });
}

function registerIpc() {
  ipcMain.on('confirm:response', (_event, payload = {}) => {
    const resolve = pendingConfirms.get(payload.id);
    if (!resolve) return;
    pendingConfirms.delete(payload.id);
    resolve(Boolean(payload.ok));
  });

  handle('app:get-state', async () => ({ state: buildState() }));

  handle('session:connect', async (input = {}) => {
    const serverUrl = normalizeServerUrl(input.serverUrl);
    const serverCode = String(input.serverCode || '').trim();
    if (!SERVER_CODE_RE.test(serverCode)) throw new Error(SERVER_ERRORS.INVALID_SERVER_CODE);
    const deviceName = cleanDeviceName(input.deviceName);
    if (!deviceName) throw new Error(S.connect.nameRequired);
    const syncFolder = path.resolve(String(input.syncFolder || config.get().syncFolder || defaultFolder()));
    const remember = Boolean(input.remember);

    send('connect-progress', S.connect.contacting);
    await checkHealth(serverUrl);

    send('connect-progress', S.connect.opening);
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
      warning: result.ok ? null : S.connect.stillStarting,
    };
  });

  handle('session:disconnect', async () => {
    const ok = await confirm(S.dialogs.disconnectTitle, S.dialogs.disconnectDetail, S.dialogs.disconnectConfirm);
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
    if (!clean) throw new Error(S.errors.renameEmpty);
    config.update({ deviceName: clean });
    let offline = false;
    if (session) offline = (await session.renameDevice(clean)).offline;
    send('config', buildState().config);
    return { deviceName: clean, offline };
  });

  handle('device:remove', async ({ deviceId, name } = {}) => {
    const ok = await confirm(
      S.dialogs.removeDeviceTitle(name),
      S.dialogs.removeDeviceDetail,
      S.dialogs.removeDeviceConfirm,
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
      title: S.dialogs.chooseFolder,
      defaultPath: config.get().syncFolder || defaultFolder(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (canceled || !filePaths.length) return { cancelled: true };
    return { folder: filePaths[0] };
  });

  handle('folder:change', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: S.dialogs.chooseNewFolder,
      defaultPath: currentFolder(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (canceled || !filePaths.length) return { cancelled: true };
    const folder = path.resolve(filePaths[0]);
    if (folder === currentFolder()) return { folder };
    if (folder === path.parse(folder).root) throw new Error(S.errors.driveRoot);
    if (folder.startsWith(app.getPath('userData'))) throw new Error(S.errors.internalFolder);
    if (session) {
      const ok = await confirm(
        S.dialogs.changeFolderTitle(folder),
        S.dialogs.changeFolderDetail,
        S.dialogs.changeFolderConfirm,
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
    if (!(await s.engine.isAvailableLocally(rel))) throw new Error(S.errors.notDownloaded);
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
      title: S.dialogs.saveCopy,
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
      isFolder ? S.dialogs.deleteFolderTitle(rel, targets.length) : S.dialogs.deleteFileTitle(path.posix.basename(rel)),
      S.dialogs.deleteDetail,
      S.dialogs.deleteConfirm,
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
    if (!list.length) throw new Error(S.errors.nothingToUpload);
    const count = await s.engine.importPaths(list, targetDir || '');
    return { count };
  });

  handle('files:pick-and-import', async (targetDir) => {
    const s = requireSession();
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: S.dialogs.uploadFiles,
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
        send('notice', { level: 'error', message: S.errors.autoConnectFailed(translateError(err)) });
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
    dialog.showErrorBox(APP_NAME, S.dialogs.startupFailed(err.stack || err.message));
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
