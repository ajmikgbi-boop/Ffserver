'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Small file + console logger. Logs live in <userData>/logs/companysync.log (rotated at 5 MB). */
function createLogger(dir, { verbose = false } = {}) {
  let stream = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'companysync.log');
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      // no previous log
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }

  const format = (arg) => {
    if (arg instanceof Error) return arg.stack || arg.message;
    if (typeof arg === 'string') return arg;
    return util.inspect(arg, { depth: 4, breakLength: Infinity });
  };

  const write = (level, args) => {
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${args.map(format).join(' ')}`;
    if (stream) stream.write(`${line}\n`);
    if (verbose || level !== 'DEBUG') {
      (level === 'ERROR' || level === 'WARN' ? console.error : console.log)(line);
    }
  };

  return {
    debug: (...args) => write('DEBUG', args),
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    file: path.join(dir, 'companysync.log'),
  };
}

module.exports = { createLogger };
