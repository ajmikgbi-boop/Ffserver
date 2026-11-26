'use strict';

/* CompanySync renderer (Arabic, right-to-left). Talks to the main process only through window.companySync. */

const api = window.companySync;
const { T, formatBytes, formatRelative, formatDateTime } = window.L10N;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ROWS = 1000;
const MAX_ACTIVITY = 250;
// Icons that point in a reading direction and must be mirrored in right-to-left layout.
const DIRECTIONAL_ICONS = new Set(['chevron']);

const state = {
  view: null,
  appVersion: '',
  platform: '',
  platformName: '',
  canLaunchAtLogin: false,
  config: {},
  session: null,
  connection: { status: 'idle' },
  sync: null,
  files: [],
  devices: [],
  activity: [],
  cwd: '',
  search: '',
  sort: { key: 'name', dir: 1 },
  tab: 'files',
  unseen: 0,
  loginFolder: null,
  connecting: false,
};

// ---------------------------------------------------------------------------
// DOM helpers (all text goes through textContent: file names are never parsed as HTML)
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Left-to-right isolated text (paths, URLs, codes, versions): slashes never flip. */
function ltr(text, props = {}) {
  return h('span', { ...props, dir: 'ltr', class: `ltr ${props.class || ''}`.trim() }, text);
}

/** User-provided text of unknown direction (device and file names), isolated from its surroundings. */
function bdi(text, props = {}) {
  return h('bdi', props, text);
}

/**
 * A path (local folder or workspace file): a left-to-right run in which every segment is
 * isolated with its own direction. Separators keep their order and Arabic names keep
 * their extension attached ("تقارير/الميزانية 2027.xlsx").
 */
function pathRun(path, tag = 'span') {
  const el = h(tag, { dir: 'ltr', class: 'ltr path-run' });
  for (const part of String(path).split(/([\\/])/)) {
    if (part === '/' || part === '\\') el.append(part);
    else if (part) el.append(h('bdi', null, part));
  }
  return el;
}

/**
 * A path that is truncated at its *start* ("…/Documents/CompanySync") when too long.
 * The outer box is right-to-left (so the overflow happens on the left) and the path
 * itself is an isolated left-to-right run, so its separators keep their order.
 */
function pathText(path, extraClass = '') {
  return h('span', { class: `path-trunc ${extraClass}`.trim(), title: path }, pathRun(path));
}

function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const classes = ['i', extraClass, DIRECTIONAL_ICONS.has(name) ? 'flip-rtl' : ''].filter(Boolean).join(' ');
  svg.setAttribute('class', classes);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function setIcon(container, name, extraClass = '') {
  container.replaceChildren(icon(name, extraClass));
}

function iconButton(name, title, onClick, extraClass = '') {
  return h('button', { class: `icon-btn ${extraClass}`.trim(), title, 'aria-label': title, type: 'button', onclick: onClick }, icon(name));
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function baseName(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? rel : rel.slice(i + 1);
}

function dirName(rel) {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1, dot + 5) : '';
}

/** Device names as shown to the user (the server uses a few fixed English placeholders). */
function deviceLabel(name, deviceId) {
  if (!name || name === 'Unknown device') return T.devices.unknown;
  if (name === 'Cloud storage' && !deviceId) return T.devices.cloudStorage;
  return name;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, level = 'info', timeout = 6000) {
  const el = h(
    'div',
    { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status' },
    h('div', { class: 'toast-text', text: message }),
    iconButton('x', T.dismiss, () => el.remove()),
  );
  $('toasts').append(el);
  const list = $('toasts');
  while (list.children.length > 4) list.firstElementChild.remove();
  if (timeout) setTimeout(() => el.remove(), timeout);
}

// ---------------------------------------------------------------------------
// Confirmation modal (requested by the main process)
// ---------------------------------------------------------------------------

const confirmQueue = [];
let activeConfirm = null;

function showNextConfirm() {
  if (activeConfirm || !confirmQueue.length) return;
  activeConfirm = confirmQueue.shift();
  const c = activeConfirm;
  $('modal-title').textContent = c.message || '';
  $('modal-detail').textContent = c.detail || '';
  $('modal-detail').hidden = !c.detail;
  $('modal-confirm').textContent = c.confirmLabel || 'متابعة';
  $('modal-confirm').className = `btn ${c.destructive ? 'btn-danger' : 'btn-primary'}`;
  $('modal-cancel').textContent = c.cancelLabel || 'إلغاء';
  const iconBox = $('modal-icon');
  iconBox.dataset.tone = c.destructive ? 'danger' : 'info';
  setIcon(iconBox, c.destructive ? 'alert' : 'power');
  $('modal').hidden = false;
  // Destructive actions default to "Cancel" so Enter never deletes by accident.
  (c.destructive ? $('modal-cancel') : $('modal-confirm')).focus();
}

function closeConfirm(ok) {
  if (!activeConfirm) return;
  api.respondConfirm(activeConfirm.id, ok);
  activeConfirm = null;
  $('modal').hidden = true;
  showNextConfirm();
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

function applyState(s) {
  state.view = s.view;
  state.appVersion = s.appVersion;
  state.platform = s.platform;
  state.platformName = s.platformName || s.platform;
  state.canLaunchAtLogin = s.canLaunchAtLogin;
  state.config = s.config || {};
  state.session = s.session;
  if (s.session) {
    state.connection = s.session.connection || { status: 'idle' };
    state.sync = s.session.sync;
    state.files = s.session.files || [];
    state.devices = s.session.devices || [];
    state.activity = (s.session.activity || []).slice(-MAX_ACTIVITY);
  } else {
    state.connection = { status: 'idle' };
    state.sync = null;
    state.files = [];
    state.devices = [];
    state.activity = [];
    state.cwd = '';
  }
  render();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.config.theme || 'system';
}

function render() {
  document.body.dataset.platform = state.platform || '';
  applyTheme();
  $('view-login').hidden = state.view !== 'login';
  $('view-dashboard').hidden = state.view !== 'dashboard';
  if (state.view === 'login') renderLogin();
  else if (state.view === 'dashboard') renderDashboard();
}

// ---------------------------------------------------------------------------
// Login view
// ---------------------------------------------------------------------------

function renderLogin() {
  const c = state.config;
  $('app-version').textContent = state.appVersion;
  const fill = (id, value) => {
    const input = $(id);
    if (document.activeElement !== input && !input.value) input.value = value || '';
  };
  fill('in-url', c.serverUrl);
  fill('in-code', c.serverCode);
  fill('in-name', c.deviceName);
  $('in-remember').checked = c.remember !== false;
  const folder = state.loginFolder || c.syncFolder || c.defaultFolder || '';
  $('in-folder').replaceChildren(pathRun(folder));
  $('in-folder').title = folder;
}

function setConnecting(busy, text) {
  state.connecting = busy;
  $('btn-connect').disabled = busy;
  $('btn-connect').textContent = busy ? T.connecting : T.connect;
  $('login-progress').hidden = !busy;
  if (text) $('login-progress-text').textContent = text;
  for (const id of ['in-url', 'in-code', 'in-name', 'in-remember', 'btn-pick-folder']) $(id).disabled = busy;
}

function showLoginError(message) {
  $('login-error').textContent = message || '';
  $('login-error').hidden = !message;
}

async function onConnect(event) {
  event.preventDefault();
  if (state.connecting) return;
  const serverUrl = $('in-url').value.trim();
  const serverCode = $('in-code').value.trim();
  const deviceName = $('in-name').value.trim();
  if (!serverUrl) return showLoginError(T.urlRequired);
  if (!serverCode) return showLoginError(T.codeRequired);
  if (!deviceName) return showLoginError(T.nameRequired);
  showLoginError('');
  setConnecting(true, T.contactingServer);
  const res = await api.connect({
    serverUrl,
    serverCode,
    deviceName,
    remember: $('in-remember').checked,
    syncFolder: state.loginFolder || state.config.syncFolder,
  });
  setConnecting(false);
  if (!res.ok) {
    showLoginError(res.error);
    return;
  }
  if (res.warning) toast(res.warning, 'warn');
  const fresh = await api.getState();
  if (fresh.ok) applyState(fresh.state);
}

async function onPickFolder() {
  const res = await api.chooseFolder();
  if (res.ok && res.folder) {
    state.loginFolder = res.folder;
    renderLogin();
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function renderDashboard() {
  renderTopbar();
  renderDevice();
  renderSync();
  renderDevices();
  renderFiles();
  renderActivity();
  renderTabs();
}

function renderTopbar() {
  const s = state.session || {};
  $('ws-code').textContent = s.serverCode || state.config.serverCode || '';
  $('ws-chip').title = `${T.conn.chipTitle} · ${s.serverUrl || state.config.serverUrl || ''}`;

  const conn = state.connection || { status: 'idle' };
  const pill = $('conn-pill');
  pill.dataset.status = conn.status;
  let host = '';
  try {
    host = new URL(conn.serverUrl || s.serverUrl).host;
  } catch {
    host = conn.serverUrl || '';
  }
  let content;
  if (conn.status === 'connected') content = [T.conn.connected, ' · ', ltr(host)];
  else if (conn.status === 'connecting') content = [`${T.conn.connectingTo} `, ltr(host), '…'];
  else if (conn.status === 'reconnecting') content = [conn.attempt > 1 ? T.conn.reconnectingAttempt(conn.attempt) : T.conn.reconnecting];
  else if (conn.status === 'error') content = [T.conn.refused];
  else content = [T.conn.idle];
  $('conn-text').replaceChildren(...content);
  pill.title = conn.error ? `${conn.serverUrl}\n${conn.error}` : conn.serverUrl || '';

  const theme = state.config.theme || 'system';
  setIcon($('btn-theme'), theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'contrast');
  $('btn-theme').title = T.theme.title(T.theme.names[theme] || theme);
}

function renderDevice() {
  const name = state.config.deviceName || (state.session && state.session.deviceName) || '';
  $('device-name').textContent = name;
  $('device-name').title = name;
  $('device-meta').replaceChildren(ltr(`${state.platformName} · CompanySync ${state.appVersion}`));
}

function renderSync() {
  const s = state.sync;
  const box = $('sync-status');
  const folder = (state.session && state.session.syncFolder) || state.config.syncFolder || '';
  $('folder-path').replaceChildren(pathRun(folder));
  $('folder-path').title = folder;
  const iconBox = box.querySelector('.sync-status-icon');
  if (!s) {
    box.dataset.state = 'stopped';
    setIcon(iconBox, 'clock');
    $('sync-title').textContent = T.sync.starting;
    $('sync-sub').replaceChildren();
    $('transfers').replaceChildren();
    return;
  }
  box.dataset.state = s.state;
  let title = T.sync.upToDate;
  let sub = s.lastSyncedAt ? [T.sync.lastSynced(formatRelative(s.lastSyncedAt))] : [];
  switch (s.state) {
    case 'idle':
      setIcon(iconBox, 'check-circle');
      break;
    case 'scanning':
      setIcon(iconBox, 'sync', 'spin');
      title = T.sync.scanning;
      break;
    case 'syncing':
      setIcon(iconBox, 'sync', 'spin');
      title = T.sync.syncing(s.pending);
      break;
    case 'offline':
      setIcon(iconBox, 'cloud-off');
      title = T.sync.offline;
      sub = [T.sync.offlineSub];
      break;
    case 'error': {
      setIcon(iconBox, 'alert');
      title = T.sync.failed(s.errorCount);
      const last = s.errors && s.errors.length ? s.errors[s.errors.length - 1] : null;
      sub = last ? [pathRun(last.path), ': ', last.message] : [T.sync.retrying];
      break;
    }
    default:
      setIcon(iconBox, 'clock');
      title = T.sync.starting;
  }
  if (s.skippedCount && s.state === 'idle') sub = [T.sync.skipped(s.skippedCount)];
  $('sync-title').textContent = title;
  $('sync-sub').replaceChildren(...sub);
  $('sync-sub').title = $('sync-sub').textContent;

  const transfers = (s.transfers || []).slice(0, 4).map((t) => {
    const pct = t.total ? Math.min(100, Math.round((t.bytes / t.total) * 100)) : 0;
    const bar = h('div');
    bar.style.width = `${pct}%`;
    return h(
      'div',
      { class: 'transfer' },
      h(
        'div',
        { class: 'transfer-head' },
        icon(t.direction === 'upload' ? 'upload' : 'download'),
        pathText(t.path, 'name'),
        h('span', { class: 'transfer-amount' }, t.total > 1024 * 1024 ? `${formatBytes(t.bytes)} / ${formatBytes(t.total)}` : `${pct}%`),
      ),
      h('div', { class: 'progress' }, bar),
    );
  });
  $('transfers').replaceChildren(...transfers);
}

function renderDevices() {
  const selfId = state.config.deviceId;
  const devices = state.devices || [];
  const online = devices.filter((d) => d.online).length;
  const count = $('devices-count');
  count.textContent = devices.length ? T.devices.count(online, devices.length) : '';
  count.dataset.online = String(online);
  count.dataset.total = String(devices.length);
  if (!devices.length) {
    $('device-list').replaceChildren(
      h('li', { class: 'muted small', text: state.connection.status === 'connected' ? T.devices.none : T.devices.afterConnect }),
    );
    return;
  }
  const items = devices.map((d) => {
    const isSelf = d.id === selfId;
    const lastSync = d.lastSync ? T.devices.lastSync(formatRelative(d.lastSync)) : T.devices.neverSynced;
    const seen = !d.online && d.lastSeen ? ` · ${T.devices.seen(formatRelative(d.lastSeen))}` : '';
    return h(
      'li',
      {
        class: `device-item ${d.online ? 'online' : ''}`,
        title: `${d.name}\n${T.devices.tooltipLastSync(formatDateTime(d.lastSync))}`,
        dataset: { deviceId: d.id },
      },
      h('div', { class: 'device-icon' }, icon('monitor')),
      h(
        'div',
        { class: 'device-body' },
        h('div', { class: 'device-name' }, bdi(d.name, { class: 'device-name-text' })),
        h(
          'div',
          { class: 'muted small device-sub' },
          isSelf ? h('span', { class: 'tag', text: T.devices.thisDevice }) : null,
          h('span', { class: 'device-sub-text', text: `${lastSync}${seen}` }),
        ),
      ),
      h('span', { class: `status-badge ${d.online ? 'online' : 'offline'}`, text: d.online ? T.devices.online : T.devices.offline }),
      !d.online && !isSelf
        ? iconButton(
            'x',
            T.devices.remove,
            async () => {
              const res = await api.removeDevice(d.id, d.name);
              if (!res.ok) toast(res.error, 'error');
            },
            'danger',
          )
        : null,
    );
  });
  $('device-list').replaceChildren(...items);
}

// ---------------------------------------------------------------------------
// Cloud file browser
// ---------------------------------------------------------------------------

function folderStatus(statuses) {
  if (statuses.has('error')) return 'error';
  if (statuses.has('uploading') || statuses.has('downloading') || statuses.has('pending')) return 'syncing';
  if (statuses.has('skipped')) return 'skipped';
  return 'synced';
}

function entriesForView() {
  const query = state.search.trim().toLowerCase();
  if (query) {
    const files = state.files.filter((f) => f.path.toLowerCase().includes(query)).map((f) => ({ ...f, name: baseName(f.path) }));
    return { folders: [], files, searching: true };
  }
  const prefix = state.cwd ? `${state.cwd}/` : '';
  const folders = new Map();
  const files = [];
  for (const f of state.files) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push({ ...f, name: rest });
      continue;
    }
    const name = rest.slice(0, slash);
    let agg = folders.get(name);
    if (!agg) {
      agg = { name, path: prefix + name, count: 0, size: 0, lastModified: 0, statuses: new Set() };
      folders.set(name, agg);
    }
    agg.count++;
    agg.size += f.size || 0;
    agg.lastModified = Math.max(agg.lastModified, f.lastModified || 0);
    agg.statuses.add(f.status);
  }
  return { folders: [...folders.values()], files, searching: false };
}

const collator = new Intl.Collator(window.L10N.LOCALE, { numeric: true, sensitivity: 'base' });

function compareBy(key, dir) {
  return (a, b) => {
    let r = 0;
    if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'modified') r = (a.lastModified || 0) - (b.lastModified || 0);
    else if (key === 'by') r = collator.compare(String(a.deviceName || ''), String(b.deviceName || ''));
    if (r === 0) r = collator.compare(a.name, b.name);
    return r * dir;
  };
}

const STATUS_ICONS = {
  synced: 'check',
  pending: 'clock',
  uploading: 'upload',
  downloading: 'download',
  syncing: 'sync',
  error: 'alert',
  skipped: 'forbid',
};

function statusBadge(status) {
  const key = STATUS_ICONS[status] ? status : 'pending';
  return h('span', { class: `status-badge ${key}` }, icon(STATUS_ICONS[key]), T.status[key]);
}

function fileIcon(name) {
  const ext = extensionOf(name);
  return h('div', { class: 'file-icon' }, ext ? h('span', { class: 'ext', dir: 'ltr', text: ext }) : icon('file'));
}

async function runAction(promise, successMessage) {
  const res = await promise;
  if (!res.ok) toast(res.error, 'error');
  else if (!res.cancelled && successMessage) toast(typeof successMessage === 'function' ? successMessage(res) : successMessage, 'success', 3500);
  return res;
}

function folderRow(folder) {
  const open = () => navigate(folder.path);
  return h(
    'tr',
    { class: 'row-folder', ondblclick: open, dataset: { path: folder.path } },
    h(
      'td',
      null,
      h(
        'div',
        { class: 'name-cell' },
        h('div', { class: 'file-icon folder' }, icon('folder')),
        bdi(folder.name, { class: 'name', title: folder.path, onclick: open }),
        h('span', { class: 'sub', text: T.files.folderCount(folder.count) }),
      ),
    ),
    h('td', { text: formatBytes(folder.size) }),
    h('td', { class: 'col-mod', text: formatRelative(folder.lastModified), title: formatDateTime(folder.lastModified) }),
    h('td', { class: 'col-by', text: '—' }),
    h('td', null, statusBadge(folderStatus(folder.statuses))),
    h(
      'td',
      null,
      h(
        'div',
        { class: 'actions' },
        iconButton('chevron', T.files.openFolder, open),
        iconButton(
          'trash',
          T.files.deleteFolder,
          () => runAction(api.deleteFile(folder.path, true), (r) => T.files.deletedFiles(r.deleted)),
          'danger',
        ),
      ),
    ),
  );
}

function fileRow(file, searching) {
  const local = file.status === 'synced' || file.status === 'uploading';
  const open = () => runAction(api.openFile(file.path));
  const dir = dirName(file.path);
  const by = deviceLabel(file.deviceName, file.deviceId);
  return h(
    'tr',
    { class: 'row-file', ondblclick: local ? open : null, dataset: { path: file.path } },
    h(
      'td',
      null,
      h(
        'div',
        { class: 'name-cell' },
        fileIcon(file.name),
        bdi(file.name, { class: 'name', title: file.path }),
        searching && dir ? pathText(dir, 'sub') : null,
      ),
    ),
    h('td', { text: formatBytes(file.size) }),
    h('td', { class: 'col-mod', text: formatRelative(file.lastModified), title: formatDateTime(file.lastModified) }),
    h('td', { class: 'col-by', title: by }, bdi(by)),
    h('td', null, statusBadge(file.status)),
    h(
      'td',
      null,
      h(
        'div',
        { class: 'actions' },
        local ? iconButton('open', T.files.open, open) : null,
        local ? iconButton('reveal', T.files.showInFolder, () => runAction(api.showFile(file.path))) : null,
        iconButton('download', T.files.saveCopy, () => runAction(api.saveFileAs(file.path), (r) => T.files.savedTo(r.savedTo))),
        iconButton('trash', T.files.delete, () => runAction(api.deleteFile(file.path, false), T.files.deletedFile), 'danger'),
      ),
    ),
  );
}

function renderBreadcrumbs() {
  const parts = state.cwd ? state.cwd.split('/') : [];
  const crumbs = [
    h(
      'button',
      { class: `crumb ${parts.length ? '' : 'current'}`, type: 'button', dataset: { root: '1' }, onclick: () => navigate('') },
      icon('home'),
      T.files.allFiles,
    ),
  ];
  parts.forEach((part, i) => {
    const target = parts.slice(0, i + 1).join('/');
    crumbs.push(h('span', { class: 'crumb-sep' }, icon('chevron')));
    crumbs.push(
      h(
        'button',
        { class: `crumb ${i === parts.length - 1 ? 'current' : ''}`, type: 'button', title: target, onclick: () => navigate(target) },
        bdi(part),
      ),
    );
  });
  if (state.search.trim()) {
    crumbs.push(h('span', { class: 'crumb-sep' }, icon('chevron')));
    crumbs.push(h('span', { class: 'crumb current' }, T.files.search(`\u2068${state.search.trim()}\u2069`)));
  }
  $('breadcrumbs').replaceChildren(...crumbs);
}

function renderFiles() {
  $('files-count').textContent = state.files.length ? String(state.files.length) : '';
  renderBreadcrumbs();
  for (const th of document.querySelectorAll('.file-table th.sortable')) {
    th.dataset.dir = th.dataset.sort === state.sort.key ? String(state.sort.dir) : '';
  }

  const { folders, files, searching } = entriesForView();
  const cmp = compareBy(state.sort.key, state.sort.dir);
  folders.sort(cmp);
  files.sort(cmp);
  const rows = [...folders.map(folderRow), ...files.slice(0, MAX_ROWS).map((f) => fileRow(f, searching))];
  $('file-rows').replaceChildren(...rows);

  const empty = $('files-empty');
  if (!rows.length) {
    let title = T.files.emptyTitle;
    let sub = T.files.emptySub;
    if (searching) {
      title = T.files.noMatchTitle;
      sub = T.files.noMatchSub;
    } else if (state.cwd) {
      title = T.files.emptyFolderTitle;
      sub = T.files.emptyFolderSub;
    } else if (state.connection.status !== 'connected' && !state.files.length) {
      title = T.files.waitingTitle;
      sub = T.files.waitingSub;
    }
    empty.replaceChildren(
      icon(searching ? 'search' : 'cloud'),
      h('div', { class: 'empty-title', text: title }),
      h('div', { class: 'muted small', text: sub }),
    );
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  const totalSize = state.files.reduce((sum, f) => sum + (f.size || 0), 0);
  let summary = T.files.summary(state.files.length, formatBytes(totalSize));
  if (files.length > MAX_ROWS) summary += T.files.showingFirst(MAX_ROWS);
  $('files-summary').textContent = summary;
}

function navigate(dir) {
  state.cwd = dir;
  state.search = '';
  $('in-search').value = '';
  renderFiles();
  document.querySelector('.table-wrap').scrollTop = 0;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

const ACTIVITY_ICONS = {
  added: 'plus',
  updated: 'edit',
  deleted: 'trash',
  'device-online': 'monitor',
  'device-offline': 'monitor',
  'device-renamed': 'edit',
  'device-removed': 'x',
  bulk: 'cloud',
  'local-warning': 'alert',
  'local-error': 'alert',
};

function describeActivity(entry) {
  const parts = {
    who: h('strong', null, bdi(deviceLabel(entry.deviceName, entry.deviceId))),
    old: h('strong', null, bdi(entry.detail || T.activity.someDevice)),
    file: entry.path ? pathRun(entry.path, 'code') : '',
  };
  const template = T.activity[entry.type];
  if (Array.isArray(template)) return template.map((piece) => (piece.startsWith('{') ? parts[piece.slice(1, -1)] : piece));
  if (entry.type === 'bulk') {
    const n = Number.parseInt(String(entry.detail || ''), 10);
    return [T.activity.bulk(Number.isFinite(n) ? n : 0)];
  }
  return [entry.detail || entry.type];
}

function activityItem(entry, fresh = false) {
  const extra = [];
  if (entry.size !== undefined && entry.type !== 'deleted') extra.push(formatBytes(entry.size));
  if (entry.local) extra.push(T.activity.fromThisDevice);
  const meta = [formatRelative(entry.ts), ...extra];
  return h(
    'li',
    { class: `activity-item ${fresh ? 'fresh' : ''}`, dataset: { type: entry.type, ts: String(entry.ts), extra: extra.join(' · ') } },
    h('div', { class: 'activity-icon' }, icon(ACTIVITY_ICONS[entry.type] || 'activity')),
    h(
      'div',
      { class: 'activity-body' },
      h('div', { class: 'activity-text' }, ...describeActivity(entry)),
      h('div', { class: 'activity-meta', text: meta.join(' · '), title: formatDateTime(entry.ts) }),
    ),
  );
}

function renderActivity() {
  const entries = [...state.activity].reverse();
  $('activity-list').replaceChildren(...entries.map((e) => activityItem(e)));
  $('activity-empty').hidden = entries.length > 0;
}

function addActivity(entry) {
  if (state.activity.some((e) => e.id === entry.id)) return;
  state.activity.push(entry);
  if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
  const list = $('activity-list');
  list.prepend(activityItem(entry, true));
  while (list.children.length > MAX_ACTIVITY) list.lastElementChild.remove();
  $('activity-empty').hidden = true;
  if (state.tab !== 'activity') {
    state.unseen++;
    renderTabs();
  }
}

function renderTabs() {
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.tab === state.tab);
  $('panel-files').hidden = state.tab !== 'files';
  $('panel-activity').hidden = state.tab !== 'activity';
  const badge = $('activity-badge');
  badge.hidden = state.unseen === 0;
  badge.textContent = state.unseen > 99 ? '99+' : String(state.unseen);
}

function refreshRelativeTimes() {
  if (state.view !== 'dashboard') return;
  renderDevices();
  renderSync();
  for (const item of document.querySelectorAll('.activity-item')) {
    const ts = Number(item.dataset.ts);
    const meta = item.querySelector('.activity-meta');
    if (ts && meta) meta.textContent = [formatRelative(ts), item.dataset.extra].filter(Boolean).join(' · ');
  }
}

// ---------------------------------------------------------------------------
// Drag & drop upload
// ---------------------------------------------------------------------------

function hasFiles(event) {
  return Boolean(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files'));
}

function setupDragAndDrop() {
  let depth = 0;
  const overlay = $('drop-overlay');
  const show = () => {
    $('drop-target').textContent = state.cwd ? T.drop.into(state.cwd) : T.drop.intoRoot;
    overlay.hidden = false;
  };
  const hide = () => {
    depth = 0;
    overlay.hidden = true;
  };

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (state.view !== 'dashboard') return;
    depth++;
    show();
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = state.view === 'dashboard' ? 'copy' : 'none';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    hide();
    if (state.view !== 'dashboard' || !event.dataTransfer) return;
    const paths = Array.from(event.dataTransfer.files || [])
      .map((file) => api.pathForFile(file))
      .filter(Boolean);
    if (!paths.length) {
      toast(T.drop.nothing, 'warn');
      return;
    }
    const res = await api.importPaths(paths, state.cwd);
    if (!res.ok) toast(res.error, 'error');
    else toast(T.files.uploading(res.count), 'success', 3000);
  });
  window.addEventListener('blur', () => {
    if (!overlay.hidden) hide();
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function startRename() {
  $('device-self').hidden = true;
  $('btn-rename').hidden = true;
  $('rename-form').hidden = false;
  const input = $('in-rename');
  input.value = state.config.deviceName || '';
  input.focus();
  input.select();
}

function stopRename() {
  $('device-self').hidden = false;
  $('btn-rename').hidden = false;
  $('rename-form').hidden = true;
}

async function submitRename(event) {
  event.preventDefault();
  const name = $('in-rename').value.trim();
  if (!name) return;
  const res = await api.renameDevice(name);
  if (!res.ok) {
    toast(res.error, 'error');
    return;
  }
  state.config.deviceName = res.deviceName;
  stopRename();
  renderDevice();
  toast(res.offline ? T.devices.renamedOffline : T.devices.renamed, 'success', 3000);
}

function bindUi() {
  $('login-form').addEventListener('submit', onConnect);
  $('btn-pick-folder').addEventListener('click', onPickFolder);

  $('btn-switch').addEventListener('click', async () => {
    const res = await api.disconnect();
    if (!res.ok) toast(res.error, 'error');
  });
  $('btn-sync-now').addEventListener('click', async () => {
    const res = await api.syncNow();
    if (!res.ok) toast(res.error, 'error');
  });
  $('btn-theme').addEventListener('click', async () => {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(state.config.theme || 'system') + 1) % order.length];
    const res = await api.setPreferences({ theme: next });
    if (res.ok) {
      state.config = res.config;
      applyTheme();
      renderTopbar();
    }
  });

  $('btn-rename').addEventListener('click', startRename);
  $('btn-rename-cancel').addEventListener('click', stopRename);
  $('rename-form').addEventListener('submit', submitRename);
  $('in-rename').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') stopRename();
  });

  $('btn-open-folder').addEventListener('click', () => runAction(api.openFolder()));
  $('btn-change-folder').addEventListener('click', async () => {
    const res = await runAction(api.changeFolder());
    if (res.ok && res.folder) {
      state.config.syncFolder = res.folder;
      if (state.session) state.session.syncFolder = res.folder;
      renderSync();
    }
  });

  $('btn-upload').addEventListener('click', () => runAction(api.pickAndImport(state.cwd), (r) => T.files.uploading(r.count)));

  $('in-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderFiles();
  });
  $('in-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = '';
      state.search = '';
      renderFiles();
    }
  });

  for (const th of document.querySelectorAll('.file-table th.sortable')) {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: key === 'name' || key === 'by' ? 1 : -1 };
      renderFiles();
    });
  }

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      if (state.tab === 'activity') state.unseen = 0;
      renderTabs();
    });
  }

  $('modal-confirm').addEventListener('click', () => closeConfirm(true));
  $('modal-cancel').addEventListener('click', () => closeConfirm(false));
  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) closeConfirm(false);
  });

  document.addEventListener('keydown', (e) => {
    if (activeConfirm) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConfirm(false);
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.view === 'dashboard') {
      e.preventDefault();
      state.tab = 'files';
      renderTabs();
      $('in-search').focus();
    }
  });

  setupDragAndDrop();
}

function subscribe() {
  api.on('view', (s) => applyState(s));
  api.on('config', (config) => {
    state.config = config;
    if (state.view === 'dashboard') {
      renderDevice();
      renderTopbar();
      renderSync();
    }
  });
  api.on('connection', (conn) => {
    state.connection = conn;
    if (state.view === 'dashboard') {
      renderTopbar();
      renderSync();
    }
  });
  api.on('sync', (sync) => {
    state.sync = sync;
    if (state.view === 'dashboard') renderSync();
  });
  api.on('files', (files) => {
    state.files = files || [];
    if (state.view === 'dashboard') renderFiles();
  });
  api.on('devices', (devices) => {
    state.devices = devices || [];
    if (state.view === 'dashboard') renderDevices();
  });
  api.on('activity', (entries) => {
    state.activity = (entries || []).slice(-MAX_ACTIVITY);
    if (state.view === 'dashboard') renderActivity();
  });
  api.on('activity:new', (entry) => {
    if (state.view === 'dashboard') addActivity(entry);
    else state.activity.push(entry);
  });
  api.on('notice', (notice) => toast(notice.message, notice.level === 'error' ? 'error' : 'warn', 9000));
  api.on('connect-progress', (text) => {
    if (state.connecting) $('login-progress-text').textContent = text;
  });
  api.on('confirm', (request) => {
    confirmQueue.push(request);
    showNextConfirm();
  });
}

async function init() {
  bindUi();
  subscribe();
  const res = await api.getState();
  if (res.ok) applyState(res.state);
  setInterval(refreshRelativeTimes, 30 * 1000);
}

init();
