'use strict';

/** Error type whose `code` and `message` are safe to send to clients. */
class SyncError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Server Codes become part of the R2 key (workspaces/{serverCode}/...), so they are
// restricted to a conservative character set. Codes are case-sensitive.
const SERVER_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_KEY_BYTES = 900; // R2 allows 1024 bytes; leave room for the workspaces/{code}/ prefix.

function validateServerCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!SERVER_CODE_RE.test(code)) {
    throw new SyncError(
      'INVALID_SERVER_CODE',
      'Server Code must be 3-64 characters: letters, numbers, "-" or "_", starting with a letter or number.',
      { permanent: true },
    );
  }
  return code;
}

function validateDeviceId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!DEVICE_ID_RE.test(id)) {
    throw new SyncError('INVALID_DEVICE', 'Invalid device id.', { permanent: true });
  }
  return id;
}

function validateDeviceName(value) {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  if (!name || name.length > 64) {
    throw new SyncError('INVALID_DEVICE_NAME', 'Device name must be 1-64 characters.');
  }
  return name;
}

function isSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function validateSha256(value, field = 'sha256') {
  const hash = typeof value === 'string' ? value.toLowerCase() : '';
  if (!SHA256_RE.test(hash)) {
    throw new SyncError('INVALID_HASH', `${field} must be a lowercase hex SHA-256 digest.`);
  }
  return hash;
}

function validateSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SyncError('INVALID_SIZE', 'size must be a non-negative integer.');
  }
  return value;
}

/**
 * Canonicalise a workspace-relative path: forward slashes, NFC, no leading slash,
 * no empty / "." / ".." segments, no control characters. Throws SyncError when invalid.
 */
function normalizeRelPath(value) {
  if (typeof value !== 'string') {
    throw new SyncError('INVALID_PATH', 'path must be a string.');
  }
  const rel = value.normalize('NFC').replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) {
    throw new SyncError('INVALID_PATH', 'path must point to a file.');
  }
  for (const segment of rel.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new SyncError('INVALID_PATH', `Invalid path segment in "${rel}".`);
    }
    if (CONTROL_RE.test(segment)) {
      throw new SyncError('INVALID_PATH', 'path contains control characters.');
    }
    if (segment.length > 255) {
      throw new SyncError('INVALID_PATH', 'A path segment is longer than 255 characters.');
    }
  }
  if (Buffer.byteLength(rel, 'utf8') > MAX_KEY_BYTES) {
    throw new SyncError('INVALID_PATH', 'path is too long.');
  }
  return rel;
}

module.exports = {
  SyncError,
  validateServerCode,
  validateDeviceId,
  validateDeviceName,
  validateSha256,
  validateSize,
  normalizeRelPath,
  isSha256,
};
