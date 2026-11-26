'use strict';

const log = require('./logger');
const {
  SyncError,
  validateServerCode,
  validateDeviceId,
  validateDeviceName,
  validateSha256,
  validateSize,
  normalizeRelPath,
} = require('./validation');

const MAX_PARTS_PER_REQUEST = 100;
const MAX_PARTS = 10000;

function toClientError(err) {
  if (err instanceof SyncError) {
    const out = { code: err.code, message: err.message };
    if (err.file !== undefined) out.file = err.file;
    return out;
  }
  log.error('Unexpected handler error', err);
  return { code: 'INTERNAL', message: 'The server could not complete the request. Please try again.' };
}

function sanitizePlatform(value) {
  return typeof value === 'string' ? value.replace(/[^\w.\- ]/g, '').slice(0, 32) : null;
}

function multipartPlan(size, preferredPartSize) {
  // R2 requires every part except the last to have the same size, at least 5 MiB,
  // and at most 10,000 parts per upload.
  const MiB = 1024 * 1024;
  let partSize = Math.max(preferredPartSize, 5 * MiB);
  if (Math.ceil(size / partSize) > MAX_PARTS) {
    partSize = Math.ceil(size / MAX_PARTS / MiB) * MiB;
  }
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}

/**
 * Socket.io protocol. Every request uses an acknowledgement callback and
 * receives `{ ok: true, ...result }` or `{ ok: false, error: { code, message } }`.
 *
 * Server -> client broadcasts (to everyone sharing a Server Code):
 *   session:ready, file:added, file:updated, file:deleted, devices:update, activity:new
 */
function registerSocketHandlers(io, { manager, storage, config, serverVersion }) {
  io.use(async (socket, next) => {
    try {
      const auth = socket.handshake.auth || {};
      const code = validateServerCode(auth.serverCode);
      if (config.allowedServerCodes && !config.allowedServerCodes.has(code)) {
        throw new SyncError('CODE_NOT_ALLOWED', 'This Server Code is not allowed on this server.', { permanent: true });
      }
      const device = {
        id: validateDeviceId(auth.deviceId),
        name: validateDeviceName(auth.deviceName),
        platform: sanitizePlatform(auth.platform),
        appVersion: sanitizePlatform(auth.appVersion),
      };
      const ws = await manager.get(code);
      socket.data.code = code;
      socket.data.device = device;
      socket.data.ws = ws;
      next();
    } catch (err) {
      const known = err instanceof SyncError;
      if (!known) log.error('Connection setup failed', err);
      const failure = new Error(known ? err.message : 'Server is temporarily unable to accept connections.');
      failure.data = { code: known ? err.code : 'UNAVAILABLE', permanent: Boolean(known && err.permanent) };
      next(failure);
    }
  });

  io.on('connection', (socket) => {
    const ws = socket.data.ws;
    const device = socket.data.device;
    socket.join(ws.room);
    ws.deviceConnected(socket.id, device);
    log.info(`[${ws.code}] device connected: ${device.name} (${device.id}) via ${socket.conn.transport.name}`);

    socket.emit('session:ready', {
      serverVersion,
      serverCode: ws.code,
      deviceId: device.id,
      devices: ws.listDevices(),
      activity: ws.recentActivity(150),
      limits: {
        multipartThresholdBytes: config.multipartThresholdBytes,
        presignExpiresSeconds: config.presignExpiresSeconds,
      },
    });

    const handle = (event, fn) => {
      socket.on(event, async (payload, ack) => {
        if (typeof ack !== 'function') return;
        try {
          const result = await fn(payload && typeof payload === 'object' ? payload : {});
          ack({ ok: true, ...(result || {}) });
        } catch (err) {
          ack({ ok: false, error: toClientError(err) });
        }
      });
    };

    // The list is computed and acknowledged in the same tick, so every broadcast the
    // client receives after this ack describes a change that is newer than the list.
    socket.on('files:list', async (_payload, ack) => {
      if (typeof ack !== 'function') return;
      try {
        await ws.ensureIndex();
        ack({ ok: true, files: ws.listFiles(), v: ws.version });
      } catch (err) {
        ack({ ok: false, error: toClientError(err) });
      }
    });

    handle('file:presign-upload', async (payload) => {
      const relPath = normalizeRelPath(payload.path);
      const sha256 = validateSha256(payload.sha256);
      const size = validateSize(payload.size);
      const hasBase = Object.prototype.hasOwnProperty.call(payload, 'baseSha256');
      const baseSha256 = hasBase && payload.baseSha256 ? validateSha256(payload.baseSha256, 'baseSha256') : null;
      await ws.ensureIndex();

      const current = ws.index.get(relPath);
      if (current && current.sha256 === sha256) {
        return { status: 'exists', file: ws.getFile(relPath) };
      }
      // Optimistic concurrency: refuse to overwrite a version the client has not seen.
      if (hasBase && current && current.sha256 !== baseSha256) {
        return { status: 'conflict', file: ws.getFile(relPath) };
      }

      const metadata = { sha256, 'device-id': device.id };
      const key = ws.objectKey(relPath);

      // Content already stored under another path (e.g. a moved or copied file):
      // server-side copy, no re-upload needed.
      const duplicate = ws.findDuplicate(sha256, size, relPath);
      if (duplicate) {
        try {
          await storage.copy(ws.objectKey(duplicate.path), key, metadata);
          const committed = await ws.commitUpload({ path: relPath, sha256, size, device });
          return { status: 'copied', file: committed.file };
        } catch (err) {
          log.debug(`[${ws.code}] server-side copy of ${duplicate.path} failed, falling back to upload`, err);
        }
      }

      if (size >= config.multipartThresholdBytes) {
        const { partSize, partCount } = multipartPlan(size, config.multipartPartSizeBytes);
        const uploadId = await storage.createMultipart(key, metadata);
        return { status: 'upload', mode: 'multipart', uploadId, partSize, partCount };
      }
      const signed = await storage.presignPut(key, metadata);
      return { status: 'upload', mode: 'single', url: signed.url, headers: signed.headers, expiresIn: signed.expiresIn };
    });

    handle('file:presign-parts', async (payload) => {
      const relPath = normalizeRelPath(payload.path);
      if (typeof payload.uploadId !== 'string' || !payload.uploadId) {
        throw new SyncError('INVALID_UPLOAD', 'uploadId is required.');
      }
      const numbers = Array.isArray(payload.partNumbers) ? payload.partNumbers : [];
      if (!numbers.length || numbers.length > MAX_PARTS_PER_REQUEST) {
        throw new SyncError('INVALID_UPLOAD', `Request between 1 and ${MAX_PARTS_PER_REQUEST} parts at a time.`);
      }
      const key = ws.objectKey(relPath);
      const parts = [];
      for (const n of numbers) {
        if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) throw new SyncError('INVALID_UPLOAD', 'Invalid part number.');
        parts.push({ partNumber: n, url: await storage.presignPart(key, payload.uploadId, n) });
      }
      return { parts };
    });

    handle('file:complete-multipart', async (payload) => {
      const relPath = normalizeRelPath(payload.path);
      const sha256 = validateSha256(payload.sha256);
      const size = validateSize(payload.size);
      if (typeof payload.uploadId !== 'string' || !payload.uploadId) {
        throw new SyncError('INVALID_UPLOAD', 'uploadId is required.');
      }
      const parts = Array.isArray(payload.parts) ? payload.parts : [];
      if (!parts.length || parts.length > MAX_PARTS) throw new SyncError('INVALID_UPLOAD', 'parts are required.');
      for (const part of parts) {
        if (!Number.isInteger(part.partNumber) || typeof part.etag !== 'string' || !part.etag) {
          throw new SyncError('INVALID_UPLOAD', 'Each part needs a partNumber and etag.');
        }
      }
      await ws.ensureIndex();
      await storage.completeMultipart(ws.objectKey(relPath), payload.uploadId, parts);
      const committed = await ws.commitUpload({ path: relPath, sha256, size, device });
      return { file: committed.file, changed: committed.changed };
    });

    handle('file:abort-multipart', async (payload) => {
      const relPath = normalizeRelPath(payload.path);
      if (typeof payload.uploadId === 'string' && payload.uploadId) {
        await storage.abortMultipart(ws.objectKey(relPath), payload.uploadId);
      }
      return {};
    });

    handle('file:commit', async (payload) => {
      const relPath = normalizeRelPath(payload.path);
      const sha256 = validateSha256(payload.sha256);
      const size = payload.size === undefined ? undefined : validateSize(payload.size);
      await ws.ensureIndex();
      const committed = await ws.commitUpload({ path: relPath, sha256, size, device });
      return { file: committed.file, changed: committed.changed };
    });

    handle('file:presign-download', async (payload) => {
      const relPath = normalizeRelPath(payload.path);
      await ws.ensureIndex();
      const file = ws.getFile(relPath);
      if (!file) throw new SyncError('NOT_FOUND', `"${relPath}" does not exist in this workspace.`, { file: null });
      const signed = await storage.presignGet(ws.objectKey(relPath));
      return { url: signed.url, expiresIn: signed.expiresIn, file };
    });

    handle('file:delete', async (payload) => {
      const relPath = normalizeRelPath(payload.path);
      const expectedSha256 = payload.expectedSha256 ? validateSha256(payload.expectedSha256, 'expectedSha256') : null;
      await ws.ensureIndex();
      return ws.deleteFile({ path: relPath, expectedSha256, device });
    });

    handle('device:rename', async (payload) => {
      const name = validateDeviceName(payload.name);
      ws.renameDevice(device.id, name);
      device.name = name;
      return { devices: ws.listDevices() };
    });

    handle('device:remove', async (payload) => {
      const targetId = validateDeviceId(payload.deviceId);
      if (targetId === device.id) throw new SyncError('INVALID_DEVICE', 'You cannot remove the device you are using.');
      ws.removeDevice(targetId);
      return { devices: ws.listDevices() };
    });

    handle('device:sync-report', async () => {
      ws.markSynced(device.id);
      return {};
    });

    handle('devices:list', async () => ({ devices: ws.listDevices() }));

    handle('activity:list', async (payload) => {
      const limit = Number.isInteger(payload.limit) ? Math.min(Math.max(payload.limit, 1), 1000) : 150;
      return { entries: ws.recentActivity(limit) };
    });

    socket.on('disconnect', (reason) => {
      ws.deviceDisconnected(socket.id, device.id);
      log.info(`[${ws.code}] device disconnected: ${device.name} (${reason})`);
    });
  });
}

module.exports = { registerSocketHandlers, multipartPlan };
