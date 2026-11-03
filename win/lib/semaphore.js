'use strict';

// Caps how many optimizer processes run at once across every file.
//
// Without this the two limits multiply: four files in flight, each running
// several optimizers in parallel, is a dozen or more CPU-bound processes
// competing for the same cores. The macOS app avoids that by putting every
// worker from every file on one queue sized to the processor count, and this
// is that queue.
class Semaphore {
    constructor(limit) {
        this.limit = Math.max(1, limit | 0);
        this.active = 0;
        this.waiting = [];
    }

    setLimit(limit) {
        this.limit = Math.max(1, limit | 0);
        this.drain();
    }

    acquire() {
        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.waiting.push(resolve));
    }

    release() {
        this.active -= 1;
        this.drain();
    }

    drain() {
        while (this.active < this.limit && this.waiting.length) {
            this.active += 1;
            this.waiting.shift()();
        }
    }

    async run(fn) {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

module.exports = { Semaphore };
