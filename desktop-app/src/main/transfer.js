'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 8 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

const IDLE_TIMEOUT_MS = 90 * 1000;

class TransferError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.name = 'TransferError';
    this.status = status;
    this.retryable = retryable;
  }
}

function abortError() {
  const err = new Error('Transfer cancelled');
  err.name = 'AbortError';
  return err;
}

/** Counts bytes (for progress) and optionally hashes the stream as it passes through. */
function meter({ hash, onProgress }) {
  let bytes = 0;
  let lastReport = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (hash) hash.update(chunk);
      const now = Date.now();
      if (onProgress && now - lastReport > 150) {
        lastReport = now;
        onProgress(bytes);
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (onProgress) onProgress(bytes);
      cb();
    },
  });
}

function readBody(res, limit = 4096) {
  return new Promise((resolve) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      if (body.length < limit) body += chunk;
    });
    res.on('end', () => resolve(body));
    res.on('error', () => resolve(body));
  });
}

function describeS3Error(status, body) {
  const code = /<Code>([^<]+)<\/Code>/.exec(body);
  const message = /<Message>([^<]+)<\/Message>/.exec(body);
  return `Storage responded ${status}${code ? ` ${code[1]}` : ''}${message ? `: ${message[1]}` : ''}`;
}

function openRequest(url, { method, headers, signal }) {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  const req = lib.request(target, { method, headers, agent: agents[target.protocol] });
  req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new TransferError('Network timeout')));
  if (signal) {
    if (signal.aborted) {
      req.destroy(abortError());
    } else {
      const onAbort = () => req.destroy(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }
  }
  return req;
}

/**
 * PUT a file (or a byte range of it) to a presigned URL, streaming from disk.
 * Resolves with the response ETag and, for whole-file uploads, the SHA-256 of the
 * bytes actually sent (so the caller can detect a file that changed mid-upload).
 */
async function uploadFile({ url, headers = {}, file, start = 0, end, onProgress, signal }) {
  const stat = await fs.promises.stat(file);
  const last = end === undefined ? stat.size - 1 : end;
  const length = Math.max(0, last - start + 1);
  const hash = start === 0 && end === undefined ? crypto.createHash('sha256') : null;

  const req = openRequest(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Length': String(length) },
    signal,
  });

  const response = new Promise((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
  });
  response.catch(() => {}); // handled below; prevents an unhandled-rejection crash

  let streamError = null;
  const source = length > 0 ? fs.createReadStream(file, { start, end: last, highWaterMark: 1024 * 1024 }) : null;
  if (source) {
    try {
      await pipeline(source, meter({ hash, onProgress }), req);
    } catch (err) {
      streamError = err; // storage may have answered early with an error; prefer that message
    }
  } else {
    req.end();
  }

  let res;
  try {
    res = await response;
  } catch (err) {
    throw streamError || err;
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await readBody(res);
    throw new TransferError(describeS3Error(res.statusCode, body), {
      status: res.statusCode,
      // 403 usually means an expired URL: retrying the same URL is pointless, the
      // sync engine retries the whole job with a freshly presigned one instead.
      retryable: res.statusCode >= 500 || res.statusCode === 408 || res.statusCode === 429,
    });
  }
  if (streamError) throw streamError;
  res.resume();
  return {
    etag: String(res.headers.etag || '').replace(/"/g, ''),
    sha256: hash ? hash.digest('hex') : null,
    bytes: length,
  };
}

/**
 * GET a presigned URL into `dest`, hashing on the fly. Rejects (and leaves cleanup to the
 * caller) if the size or SHA-256 differs from what the server announced.
 */
async function downloadToFile({ url, dest, expectedSha256, expectedSize, onProgress, signal }) {
  const req = openRequest(url, { method: 'GET', headers: {}, signal });
  const res = await new Promise((resolve, reject) => {
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
  if (res.statusCode !== 200) {
    const body = await readBody(res);
    throw new TransferError(describeS3Error(res.statusCode, body), {
      status: res.statusCode,
      retryable: res.statusCode !== 404,
    });
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await pipeline(
    res,
    meter({
      hash,
      onProgress: (b) => {
        bytes = b;
        if (onProgress) onProgress(b);
      },
    }),
    fs.createWriteStream(dest),
  );
  const sha256 = hash.digest('hex');
  if (typeof expectedSize === 'number' && bytes !== expectedSize) {
    throw new TransferError(`Downloaded ${bytes} bytes but expected ${expectedSize}`);
  }
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new TransferError('Downloaded file failed SHA-256 verification');
  }
  return { sha256, size: bytes };
}

/** Retry an async operation with exponential backoff while errors are retryable. */
async function withRetry(fn, { attempts = 4, baseDelayMs = 1000, signal } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (signal && signal.aborted) throw abortError();
    try {
      return await fn(i);
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError' || err.retryable === false || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastError;
}

module.exports = { uploadFile, downloadToFile, withRetry, TransferError };
