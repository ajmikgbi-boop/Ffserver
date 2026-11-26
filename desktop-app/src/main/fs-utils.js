'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { S } = require('./i18n');

/** Folder inside the sync root used for in-progress downloads. Never synced. */
const INTERNAL_DIR = '.companysync';

const IGNORED_NAMES = new Set([
  INTERNAL_DIR,
  '.ds_store',
  'thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  '$recycle.bin',
  'system volume information',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd',
  '.temporaryitems',
  '.documentrevisions-v100',
  'icon\r',
]);

const IGNORED_PATTERNS = [
  /^~\$/, // Microsoft Office owner/lock files
  /^\.~lock\..*#$/, // LibreOffice lock files
  /^\._/, // macOS AppleDouble resource forks
  /\.(tmp|temp|crdownload|partial|part|download|swp|swx)$/i,
  /^~.*\.tmp$/i,
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WINDOWS_INVALID_CHARS = /[<>:"|?*\u0000-\u001f]/;

function isIgnoredName(name) {
  const lower = name.toLowerCase();
  if (IGNORED_NAMES.has(lower)) return true;
  return IGNORED_PATTERNS.some((re) => re.test(name));
}

/** True when any segment of a workspace-relative path is ignored. */
function isIgnoredRel(rel) {
  return rel.split('/').some(isIgnoredName);
}

/** Absolute path -> canonical workspace-relative path ("a/b.txt"), or null when outside root. */
function toRel(root, abs) {
  const relative = path.relative(root, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/').normalize('NFC');
}

/** Workspace-relative path -> absolute path, guaranteed to stay inside root. */
function toAbs(root, rel) {
  const abs = path.resolve(root, ...rel.split('/'));
  const back = path.relative(root, abs);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(S.sync.outsideRoot(rel));
  }
  return abs;
}

/** Whether a remote path can be written on this operating system. */
function isPortablePath(rel, platform = process.platform) {
  if (platform !== 'win32') return true;
  return rel.split('/').every(
    (segment) => !WINDOWS_INVALID_CHARS.test(segment) && !WINDOWS_RESERVED.test(segment) && !/[. ]$/.test(segment),
  );
}

function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(abs, { highWaterMark: 1024 * 1024 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function statOrNull(abs) {
  try {
    return await fsp.stat(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Recursively list regular files below `root` (symlinks are not followed).
 * Returns Map<relPath, { size, mtimeMs }>.
 */
async function walk(root, startRel = '') {
  const files = new Map();
  const startAbs = startRel ? toAbs(root, startRel) : root;
  const stack = [startAbs];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'ENOTDIR') continue;
      throw err;
    }
    for (const entry of entries) {
      if (isIgnoredName(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        const rel = toRel(root, abs);
        if (!rel) continue;
        try {
          const st = await fsp.stat(abs);
          files.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished while scanning
        }
      }
    }
  }
  return files;
}

/** "report.docx" -> "report (نسخة متعارضة من Office PC 2026-01-31 1405).docx" */
function conflictRel(rel, deviceName, date = new Date()) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const base = rel.slice(dir.length);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  const safeDevice =
    String(deviceName || S.sync.thisDevice)
      .replace(/[<>:"/\\|?*\u0000-\u001f\u2066-\u2069]/g, '')
      .trim() || S.sync.thisDevice;
  return `${dir}${S.sync.conflictCopyName(stem, safeDevice, stamp, ext)}`;
}

/** "a/b.txt" -> "a/b (2).txt" for n = 2 */
function numberedRel(rel, n) {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const base = rel.slice(dir.length);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  return `${dir}${stem} (${n})${ext}`;
}

/** Remove now-empty directories from `dirAbs` upwards, stopping at (and never removing) root. */
async function pruneEmptyDirs(root, dirAbs) {
  let current = dirAbs;
  while (current && current !== root && current.startsWith(root)) {
    try {
      const entries = await fsp.readdir(current);
      if (entries.length) return;
      await fsp.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/** Rename with retries (Windows may briefly lock files that antivirus or indexers are reading). */
async function renameWithRetry(from, to, attempts = 6) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fsp.copyFile(from, to);
        await fsp.rm(from, { force: true });
        return;
      }
      const retryable = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!retryable || i >= attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return fallback;
    throw err;
  }
}

/** Write JSON via a temp file + rename so a crash never leaves a half-written file. */
async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf8');
  try {
    await renameWithRetry(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

function writeJsonAtomicSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = {
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
  readJson,
  writeJsonAtomic,
  writeJsonAtomicSync,
};
