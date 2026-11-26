'use strict';

const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const log = require('./logger');
const config = require('./config');
const { R2Storage } = require('./r2');
const { WorkspaceManager } = require('./workspace');
const { registerSocketHandlers } = require('./socket');
const { version: serverVersion } = require('../package.json');

const startedAt = new Date();
const storage = new R2Storage({ ...config.r2, presignExpiresSeconds: config.presignExpiresSeconds });

const app = express();
// Render (and Cloudflare in front of it) terminate TLS and forward requests.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.use(cors({ origin: true, credentials: true }));

// Lightweight liveness probe for Render health checks and UptimeRobot. It never
// touches R2, so frequent pings cost nothing.
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()), time: new Date().toISOString() });
});

app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    name: 'CompanySync Server',
    version: serverVersion,
    status: 'ok',
    startedAt: startedAt.toISOString(),
    ...manager.stats(),
  });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const server = http.createServer(app);
// Keep idle HTTP connections open longer than upstream proxies do, to avoid 502s.
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

const io = new Server(server, {
  cors: { origin: true, credentials: true },
  serveClient: false,
  // Pings every 25 s keep WebSockets alive through Cloudflare's 100 s idle timeout.
  pingInterval: 25 * 1000,
  pingTimeout: 20 * 1000,
  maxHttpBufferSize: 5 * 1024 * 1024,
});

const manager = new WorkspaceManager({ storage, config, io });
registerSocketHandlers(io, { manager, storage, config, serverVersion });

server.listen(config.port, '0.0.0.0', () => {
  log.info(
    `CompanySync server v${serverVersion} listening on port ${config.port} ` +
      `(bucket "${config.r2.bucket}", ${config.allowedServerCodes ? `${config.allowedServerCodes.size} allowed codes` : 'any server code'})`,
  );
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} received: flushing workspace metadata to R2 and shutting down`);
  const force = setTimeout(() => {
    log.warn('Forced exit after shutdown timeout');
    process.exit(1);
  }, 15 * 1000);
  force.unref();
  try {
    await manager.flushAll();
  } catch (err) {
    log.error('Flush during shutdown failed', err);
  }
  io.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', reason));
process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
  shutdown('uncaughtException');
});
