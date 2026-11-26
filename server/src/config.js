'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Local development convenience: load server/.env when present (Node >= 20.12).
// On Render, variables come from the dashboard and no file is read.
const envFile = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

function str(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function required(name) {
  const value = str(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function int(name, fallback, min, max) {
  const raw = str(name);
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return value;
}

function trustProxy() {
  const raw = str('TRUST_PROXY', '1');
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

const MiB = 1024 * 1024;
const endpointOverride = str('R2_ENDPOINT');
const accountId = endpointOverride ? str('R2_ACCOUNT_ID') : required('R2_ACCOUNT_ID');

const allowedServerCodes = str('ALLOWED_SERVER_CODES')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);

const config = Object.freeze({
  port: int('PORT', 3000, 1, 65535),
  trustProxy: trustProxy(),
  r2: Object.freeze({
    accountId,
    endpoint: endpointOverride || `https://${accountId}.r2.cloudflarestorage.com`,
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
    bucket: required('R2_BUCKET_NAME'),
  }),
  allowedServerCodes: allowedServerCodes.length ? new Set(allowedServerCodes) : null,
  presignExpiresSeconds: int('PRESIGN_EXPIRES_SECONDS', 3600, 60, 7 * 24 * 3600),
  multipartThresholdBytes: int('MULTIPART_THRESHOLD_BYTES', 100 * MiB, 5 * MiB, 5 * 1024 * MiB),
  multipartPartSizeBytes: int('MULTIPART_PART_SIZE_BYTES', 16 * MiB, 5 * MiB, 1024 * MiB),
  // How long the in-memory file index may be served before it is re-validated against R2.
  indexMaxAgeMs: int('INDEX_MAX_AGE_SECONDS', 300, 30, 86400) * 1000,
  // Debounce for writing workspace metadata (devices, activity, manifest) back to R2.
  flushDelayMs: int('FLUSH_DELAY_MS', 3000, 250, 60000),
  activityLimit: int('ACTIVITY_LIMIT', 300, 20, 5000),
  // A device must stay disconnected this long before an "offline" activity entry is logged.
  offlineGraceMs: int('OFFLINE_GRACE_SECONDS', 45, 0, 3600) * 1000,
  // Idle workspaces (no devices connected) are flushed and evicted from memory after this long.
  workspaceIdleMs: int('WORKSPACE_IDLE_SECONDS', 600, 60, 86400) * 1000,
});

module.exports = config;
