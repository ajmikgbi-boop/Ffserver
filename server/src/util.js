'use strict';

/**
 * Run `fn` over `items` with at most `limit` concurrent invocations.
 * Results are returned in input order.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Simple counting semaphore for limiting expensive work (e.g. hashing large objects). */
class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.waiters = [];
  }

  async run(fn) {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const wake = this.waiters.shift();
      if (wake) wake();
    }
  }
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = { mapLimit, Semaphore, randomId };
