'use strict';

const { EventEmitter } = require('node:events');
const { io } = require('socket.io-client');
const { S, SERVER_ERRORS } = require('./i18n');

const FORWARDED_EVENTS = ['file:added', 'file:updated', 'file:deleted', 'devices:update', 'activity:new'];

class OfflineError extends Error {
  constructor(message = SERVER_ERRORS.OFFLINE) {
    super(message);
    this.name = 'OfflineError';
    this.code = 'OFFLINE';
  }
}

class RequestError extends Error {
  constructor({ code, message, file }) {
    // Server messages are English; show the Arabic text for the error code instead.
    super(SERVER_ERRORS[code] || SERVER_ERRORS.ERROR);
    this.name = 'RequestError';
    this.code = code || 'ERROR';
    this.serverMessage = message || null;
    if (file !== undefined) this.file = file;
  }
}

/** Accepts "sync.example.com", "https://sync.example.com/" etc. and returns a clean origin URL. */
function normalizeServerUrl(input) {
  let value = String(input || '').trim();
  if (!value) throw new Error(S.connect.serverUrlRequired);
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(S.connect.serverUrlInvalid);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(S.connect.serverUrlScheme);
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

/**
 * Socket.io connection to the coordination server.
 *
 * Reconnection is infinite: if the server restarts, sleeps, or is moved to a new
 * Render account behind the same custom domain, the client keeps retrying the
 * same URL and transparently resumes (the engine re-syncs on every "ready").
 */
class CloudClient extends EventEmitter {
  constructor({ serverUrl, serverCode, deviceId, deviceName, platform, appVersion }) {
    super();
    this.serverUrl = serverUrl;
    this.serverCode = serverCode;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.platform = platform;
    this.appVersion = appVersion;
    this.socket = null;
    this.status = 'idle'; // idle | connecting | connected | reconnecting | error
    this.lastError = null;
    this.attempt = 0;
    this.manualRetryTimer = null;
    this.manualRetryDelay = 5000;
    this.stopped = false;
    this.ready = false;
  }

  get connected() {
    return Boolean(this.socket && this.socket.connected && this.ready);
  }

  start() {
    this.stopped = false;
    const socket = io(this.serverUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      tryAllTransports: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      timeout: 30000,
      autoConnect: false,
      // Evaluated on every (re)connection, so a rename is picked up automatically.
      auth: (cb) =>
        cb({
          serverCode: this.serverCode,
          deviceId: this.deviceId,
          deviceName: this.deviceName,
          platform: this.platform,
          appVersion: this.appVersion,
        }),
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.attempt = 0;
      this.lastError = null;
      this.manualRetryDelay = 5000;
      this._setStatus('connected');
    });

    socket.on('session:ready', (data) => {
      this.ready = true;
      this.emit('ready', data);
      this._setStatus('connected');
    });

    socket.on('disconnect', (reason) => {
      this.ready = false;
      if (this.stopped) return;
      this._setStatus('reconnecting', reason === 'io server disconnect' ? S.connect.serverClosed : null);
      this.emit('disconnected', reason);
      // A server-initiated disconnect does not auto-reconnect in Socket.io; we always want to.
      if (reason === 'io server disconnect') this._scheduleManualReconnect();
    });

    socket.on('connect_error', (err) => {
      this.ready = false;
      if (this.stopped) return;
      const data = err && err.data ? err.data : {};
      // Middleware errors carry a code (translated); transport errors ("xhr poll error"…) do not.
      const message = (data.code && SERVER_ERRORS[data.code]) || S.connect.connectFailed;
      this.lastError = { message, code: data.code || null, permanent: !!data.permanent, detail: err.message || null };
      this._setStatus(data.permanent ? 'error' : 'reconnecting', this.lastError.message);
      this.emit('connect-error', this.lastError);
      // Errors raised by server middleware stop Socket.io's automatic reconnection
      // (socket.active === false). Keep trying ourselves with a slower backoff, so a
      // fixed server configuration or a failover is picked up without user action.
      if (!socket.active) this._scheduleManualReconnect(data.permanent ? 60000 : undefined);
    });

    socket.io.on('reconnect_attempt', (attempt) => {
      this.attempt = attempt;
      this._setStatus('reconnecting', this.lastError ? this.lastError.message : null);
    });

    for (const event of FORWARDED_EVENTS) {
      socket.on(event, (payload) => this.emit(event, payload));
    }

    this._setStatus('connecting');
    socket.connect();
  }

  _scheduleManualReconnect(fixedDelay) {
    if (this.manualRetryTimer || this.stopped) return;
    const delay = fixedDelay || this.manualRetryDelay;
    this.manualRetryDelay = Math.min(this.manualRetryDelay * 2, 60000);
    this.manualRetryTimer = setTimeout(() => {
      this.manualRetryTimer = null;
      if (!this.stopped && this.socket && !this.socket.connected) {
        this.attempt++;
        this._setStatus('reconnecting', this.lastError ? this.lastError.message : null);
        this.socket.connect();
      }
    }, delay);
  }

  /** Force an immediate reconnection attempt (e.g. after the computer wakes from sleep). */
  reconnectNow() {
    if (this.stopped || !this.socket || this.socket.connected) return;
    if (this.manualRetryTimer) {
      clearTimeout(this.manualRetryTimer);
      this.manualRetryTimer = null;
    }
    this.socket.disconnect();
    this.socket.connect();
  }

  _setStatus(status, error = null) {
    this.status = status;
    this.emit('status', this.getStatus(error));
  }

  getStatus(error = null) {
    return {
      status: this.status,
      serverUrl: this.serverUrl,
      serverCode: this.serverCode,
      attempt: this.attempt,
      error: error || (this.status !== 'connected' && this.lastError ? this.lastError.message : null),
      transport: this.socket && this.socket.io && this.socket.io.engine ? this.socket.io.engine.transport.name : null,
    };
  }

  /** Send a request and wait for its acknowledgement. Throws OfflineError when disconnected. */
  async request(event, payload = {}, timeoutMs = 30000) {
    if (!this.connected) throw new OfflineError();
    let res;
    try {
      res = await this.socket.timeout(timeoutMs).emitWithAck(event, payload);
    } catch (err) {
      if (!this.connected) throw new OfflineError();
      const timeout = new Error(SERVER_ERRORS.TIMEOUT);
      timeout.code = 'TIMEOUT';
      throw timeout;
    }
    if (!res || !res.ok) {
      throw new RequestError(res && res.error ? res.error : { code: 'ERROR' });
    }
    return res;
  }

  setDeviceName(name) {
    this.deviceName = name;
  }

  stop() {
    this.stopped = true;
    this.ready = false;
    if (this.manualRetryTimer) clearTimeout(this.manualRetryTimer);
    this.manualRetryTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.io.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this._setStatus('idle');
  }
}

module.exports = { CloudClient, OfflineError, RequestError, normalizeServerUrl };
