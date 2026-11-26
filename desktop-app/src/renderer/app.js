'use strict';

/* CompanySync renderer. Talks to the main process only through window.companySync. */

const api = window.companySync;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_ROWS = 1000;
const MAX_ACTIVITY = 250;

const state = {
  view: null,
  appVersion: '',
  platform: '',
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

function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `i ${extraClass}`.trim());
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
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

function formatRelative(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 45 * 1000) return 'just now';
  const min = Math.round(diff / 60000);
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDateTime(ts) {
  return ts ? new Date(ts).toLocaleString() : '';
}

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

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, level = 'info', timeout = 6000) {
  const el = h(
    'div',
    { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status' },
    h('div', { class: 'toast-text', text: message }),
    iconButton('x', 'Dismiss', () => el.remove()),
  );
  $('toasts').append(el);
  const list = $('toasts');
  while (list.children.length > 4) list.firstElementChild.remove();
  if (timeout) setTimeout(() => el.remove(), timeout);
}

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

function applyState(s) {
  state.view = s.view;
  state.appVersion = s.appVersion;
  state.platform = s.platform;
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
  $('in-folder').textContent = `\u200E${folder}\u200E`;
  $('in-folder').title = folder;
}

function setConnecting(busy, text) {
  state.connecting = busy;
  $('btn-connect').disabled = busy;
  $('btn-connect').textContent = busy ? 'Connecting…' : 'Connect';
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
  if (!serverUrl) return showLoginError('Enter the Server URL, e.g. https://sync.yourcompany.com');
  if (!serverCode) return showLoginError('Enter the Server Code for your workspace.');
  if (!deviceName) return showLoginError('Give this device a name, e.g. "Main Office PC".');
  showLoginError('');
  setConnecting(true, 'Contacting the server…');
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
  $('ws-chip').title = `Server Code · ${s.serverUrl || state.config.serverUrl || ''}`;

  const conn = state.connection || { status: 'idle' };
  const pill = $('conn-pill');
  pill.dataset.status = conn.status;
  let text = 'Not connected';
  let host = '';
  try {
    host = new URL(conn.serverUrl || s.serverUrl).host;
  } catch {
    host = conn.serverUrl || '';
  }
  if (conn.status === 'connected') text = `Connected · ${host}`;
  else if (conn.status === 'connecting') text = `Connecting to ${host}…`;
  else if (conn.status === 'reconnecting') text = conn.attempt > 1 ? `Reconnecting… (attempt ${conn.attempt})` : 'Reconnecting…';
  else if (conn.status === 'error') text = 'Connection refused';
  $('conn-text').textContent = text;
  pill.title = conn.error ? `${conn.serverUrl}\n${conn.error}` : conn.serverUrl || '';

  const theme = state.config.theme || 'system';
  setIcon($('btn-theme'), theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'contrast');
  $('btn-theme').title = `Theme: ${theme} (click to change)`;
}

function renderDevice() {
  const name = state.config.deviceName || (state.session && state.session.deviceName) || '';
  $('device-name').textContent = name;
  $('device-name').title = name;
  const platformName = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[state.platform] || state.platform;
  $('device-meta').textContent = `${platformName} · CompanySync ${state.appVersion}`;
}

function renderSync() {
  const s = state.sync;
  const box = $('sync-status');
  const folder = (state.session && state.session.syncFolder) || state.config.syncFolder || '';
  $('folder-path').textContent = `\u200E${folder}\u200E`;
  $('folder-path').title = folder;
  if (!s) {
    box.dataset.state = 'stopped';
    setIcon(box.querySelector('.sync-status-icon'), 'clock');
    $('sync-title').textContent = 'Starting…';
    $('sync-sub').textContent = '';
    $('transfers').replaceChildren();
    return;
  }
  const iconBox = box.querySelector('.sync-status-icon');
  box.dataset.state = s.state;
  let title = 'Up to date';
  let sub = s.lastSyncedAt ? `Last synced ${formatRelative(s.lastSyncedAt)}` : '';
  switch (s.state) {
    case 'idle':
      setIcon(iconBox, 'check-circle');
      break;
    case 'scanning':
      setIcon(iconBox, 'sync', 'spin');
      title = 'Checking for changes…';
      break;
    case 'syncing':
      setIcon(iconBox, 'sync', 'spin');
      title = `Syncing ${s.pending} item${s.pending === 1 ? '' : 's'}…`;
      break;
    case 'offline':
      setIcon(iconBox, 'cloud-off');
      title = 'Offline';
      sub = 'Changes are synced automatically once the server is reachable.';
      break;
    case 'error':
      setIcon(iconBox, 'alert');
      title = `${s.errorCount} item${s.errorCount === 1 ? '' : 's'} could not sync`;
      sub = s.errors && s.errors.length ? `${s.errors[s.errors.length - 1].path}: ${s.errors[s.errors.length - 1].message}` : 'Retrying automatically';
      break;
    default:
      setIcon(iconBox, 'clock');
      title = 'Starting…';
  }
  if (s.skippedCount && s.state === 'idle') sub = `${s.skippedCount} item(s) skipped — see Activity`;
  $('sync-title').textContent = title;
  $('sync-sub').textContent = sub;
  $('sync-sub').title = sub;

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
        h('span', { class: 'name', text: t.path, title: t.path }),
        h('span', { text: t.total > 1024 * 1024 ? `${formatBytes(t.bytes)} / ${formatBytes(t.total)}` : `${pct}%` }),
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
  $('devices-count').textContent = devices.length ? `${online}/${devices.length} online` : '';
  if (!devices.length) {
    $('device-list').replaceChildren(
      h('li', { class: 'muted small', text: state.connection.status === 'connected' ? 'No devices yet.' : 'Device list appears once connected.' }),
    );
    return;
  }
  const items = devices.map((d) => {
    const isSelf = d.id === selfId;
    const lastSync = d.lastSync ? `Last sync ${formatRelative(d.lastSync)}` : 'Never synced';
    const seen = !d.online && d.lastSeen ? ` · seen ${formatRelative(d.lastSeen)}` : '';
    return h(
      'li',
      { class: `device-item ${d.online ? 'online' : ''}`, title: `${d.name}\nLast sync: ${formatDateTime(d.lastSync) || 'never'}` },
      h('div', { class: 'device-icon' }, icon('monitor')),
      h(
        'div',
        { class: 'device-body' },
        h('div', { class: 'device-name' }, h('span', { text: d.name }), isSelf ? h('span', { class: 'tag', text: 'This device' }) : null),
        h('div', { class: 'muted small', text: `${lastSync}${seen}` }),
      ),
      h('span', { class: `status-badge ${d.online ? 'online' : 'offline'}`, text: d.online ? 'Online' : 'Offline' }),
      !d.online && !isSelf
        ? iconButton('x', 'Remove from list', async () => {
            const res = await api.removeDevice(d.id, d.name);
            if (!res.ok) toast(res.error, 'error');
          }, 'danger')
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

function compareBy(key, dir) {
  return (a, b) => {
    let r = 0;
    if (key === 'size') r = (a.size || 0) - (b.size || 0);
    else if (key === 'modified') r = (a.lastModified || 0) - (b.lastModified || 0);
    else if (key === 'by') r = String(a.deviceName || '').localeCompare(String(b.deviceName || ''));
    if (r === 0) r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return r * dir;
  };
}

function statusBadge(status) {
  const labels = {
    synced: ['check', 'Synced'],
    pending: ['clock', 'Pending'],
    uploading: ['upload', 'Uploading'],
    downloading: ['download', 'Downloading'],
    syncing: ['sync', 'Syncing'],
    error: ['alert', 'Error'],
    skipped: ['forbid', 'Skipped'],
  };
  const [ic, label] = labels[status] || labels.pending;
  return h('span', { class: `status-badge ${status}` }, icon(ic), label);
}

function fileIcon(name) {
  const ext = extensionOf(name);
  return h('div', { class: 'file-icon' }, ext ? h('span', { class: 'ext', text: ext }) : icon('file'));
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
    { class: 'row-folder', ondblclick: open },
    h(
      'td',
      null,
      h(
        'div',
        { class: 'name-cell' },
        h('div', { class: 'file-icon folder' }, icon('folder')),
        h('span', { class: 'name', text: folder.name, title: folder.path, onclick: open }),
        h('span', { class: 'sub', text: `${folder.count} file${folder.count === 1 ? '' : 's'}` }),
      ),
    ),
    h('td', { text: formatBytes(folder.size) }),
    h('td', { text: formatRelative(folder.lastModified), title: formatDateTime(folder.lastModified) }),
    h('td', { class: 'col-by', text: '—' }),
    h('td', null, statusBadge(folderStatus(folder.statuses))),
    h(
      'td',
      null,
      h(
        'div',
        { class: 'actions' },
        iconButton('chevron', 'Open folder', open),
        iconButton('trash', 'Delete folder from cloud', () => runAction(api.deleteFile(folder.path, true), (r) => `Deleted ${r.deleted} file(s)`), 'danger'),
      ),
    ),
  );
}

function fileRow(file, searching) {
  const local = file.status === 'synced' || file.status === 'uploading';
  const open = () => runAction(api.openFile(file.path));
  const dir = dirName(file.path);
  return h(
    'tr',
    { class: 'row-file', ondblclick: local ? open : null },
    h(
      'td',
      null,
      h(
        'div',
        { class: 'name-cell' },
        fileIcon(file.name),
        h('span', { class: 'name', text: file.name, title: file.path }),
        searching && dir ? h('span', { class: 'sub', text: dir, title: dir }) : null,
      ),
    ),
    h('td', { text: formatBytes(file.size) }),
    h('td', { text: formatRelative(file.lastModified), title: formatDateTime(file.lastModified) }),
    h('td', { class: 'col-by', text: file.deviceName || '—', title: file.deviceName || '' }),
    h('td', null, statusBadge(file.status)),
    h(
      'td',
      null,
      h(
        'div',
        { class: 'actions' },
        local ? iconButton('open', 'Open', open) : null,
        local ? iconButton('reveal', 'Show in folder', () => runAction(api.showFile(file.path))) : null,
        iconButton('download', 'Save a copy…', () => runAction(api.saveFileAs(file.path), (r) => `Saved to ${r.savedTo}`)),
        iconButton('trash', 'Delete from cloud', () => runAction(api.deleteFile(file.path, false), 'File deleted'), 'danger'),
      ),
    ),
  );
}

function renderBreadcrumbs() {
  const parts = state.cwd ? state.cwd.split('/') : [];
  const crumbs = [
    h('button', { class: `crumb ${parts.length ? '' : 'current'}`, type: 'button', onclick: () => navigate('') }, icon('home'), 'All files'),
  ];
  parts.forEach((part, i) => {
    const target = parts.slice(0, i + 1).join('/');
    crumbs.push(h('span', { class: 'crumb-sep' }, icon('chevron')));
    crumbs.push(
      h('button', { class: `crumb ${i === parts.length - 1 ? 'current' : ''}`, type: 'button', title: target, onclick: () => navigate(target) }, part),
    );
  });
  if (state.search.trim()) {
    crumbs.push(h('span', { class: 'crumb-sep' }, icon('chevron')));
    crumbs.push(h('span', { class: 'crumb current', text: `Search: "${state.search.trim()}"` }));
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
    let title = 'No files yet';
    let sub = 'Drop files here, click Upload, or add files to your sync folder.';
    if (searching) {
      title = 'No matching files';
      sub = 'Try a different search.';
    } else if (state.cwd) {
      title = 'This folder is empty';
      sub = 'Drop files here to upload them into this folder.';
    } else if (state.connection.status !== 'connected' && !state.files.length) {
      title = 'Waiting for the server';
      sub = 'The file list appears as soon as the connection is established.';
    }
    empty.replaceChildren(icon(searching ? 'search' : 'cloud'), h('div', { class: 'empty-title', text: title }), h('div', { class: 'muted small', text: sub }));
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  const totalSize = state.files.reduce((sum, f) => sum + (f.size || 0), 0);
  let summary = `${state.files.length} file${state.files.length === 1 ? '' : 's'} · ${formatBytes(totalSize)} in workspace`;
  if (files.length > MAX_ROWS) summary += ` · showing first ${MAX_ROWS} results`;
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
  const who = h('strong', { text: entry.deviceName || 'Unknown device' });
  const file = entry.path ? h('code', { text: entry.path }) : null;
  switch (entry.type) {
    case 'added':
      return [who, ' uploaded ', file];
    case 'updated':
      return [who, ' updated ', file];
    case 'deleted':
      return [who, ' deleted ', file];
    case 'device-online':
      return [who, ' came online'];
    case 'device-offline':
      return [who, ' went offline'];
    case 'device-renamed':
      return [h('strong', { text: entry.detail || 'A device' }), ' was renamed to ', who];
    case 'device-removed':
      return [who, ' was removed from the device list'];
    default:
      return [entry.detail || entry.type];
  }
}

function activityItem(entry, fresh = false) {
  const extra = [];
  if (entry.size !== undefined && entry.type !== 'deleted') extra.push(formatBytes(entry.size));
  if (entry.local) extra.push('this device');
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
    $('drop-target').textContent = `Into ${state.cwd ? `“${state.cwd}”` : 'the workspace root'} — files are copied into your sync folder and uploaded`;
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
      toast('Nothing to upload: only files and folders from your computer can be dropped here.', 'warn');
      return;
    }
    const res = await api.importPaths(paths, state.cwd);
    if (!res.ok) toast(res.error, 'error');
    else toast(`Uploading ${res.count} file${res.count === 1 ? '' : 's'}…`, 'success', 3000);
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
  toast(res.offline ? 'Renamed. Other devices will see the new name once you are back online.' : 'Device renamed', 'success', 3000);
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

  $('btn-upload').addEventListener('click', () =>
    runAction(api.pickAndImport(state.cwd), (r) => `Uploading ${r.count} file${r.count === 1 ? '' : 's'}…`),
  );

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

  document.addEventListener('keydown', (e) => {
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
}

async function init() {
  bindUi();
  subscribe();
  const res = await api.getState();
  if (res.ok) applyState(res.state);
  setInterval(refreshRelativeTimes, 30 * 1000);
}

init();
