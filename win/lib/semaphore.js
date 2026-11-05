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
        this.waiting = []; // { grant } in arrival order
    }

    setLimit(limit) {
        this.limit = Math.max(1, limit | 0);
        this.drain();
    }

    // Resolves true once a slot is held, or false if `signal` aborts first, in
    // which case no slot was taken. Without the signal, a file that was
    // stopped kept its place in line, and each of its optimizers still got a
    // slot - and did its copying and decoding - only to be killed at once.
    acquire(signal = null) {
        if (signal && signal.aborted) return Promise.resolve(false);
        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve(true);
        }
        return new Promise((resolve) => {
            const onAbort = () => {
                const at = this.waiting.indexOf(waiter);
                if (at >= 0) this.waiting.splice(at, 1);
                resolve(false);
            };
            const waiter = {
                grant: () => {
                    if (signal) signal.removeEventListener('abort', onAbort);
                    resolve(true);
                },
            };
            this.waiting.push(waiter);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    release() {
        this.active -= 1;
        this.drain();
    }

    drain() {
        while (this.active < this.limit && this.waiting.length) {
            this.active += 1;
            this.waiting.shift().grant();
        }
    }

    // Runs fn in a slot. Returns null without running it if `signal` aborts
    // while it waits.
    async run(fn, signal = null) {
        if (!(await this.acquire(signal))) return null;
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    // How many threads a tool starting now should use, out of `cores`.
    // oxipng, pngquant, cwebp and avifenc each start one thread per core by
    // default, so eight of them at once ran eight times as many threads as
    // the PC has. The cores are shared among the slots in use - or among all
    // of them while others wait, since those will start as soon as any ends.
    // The last file of a batch, running alone, gets every core.
    threadsPerSlot(cores) {
        const sharers = this.waiting.length ? this.limit : Math.max(1, this.active);
        return Math.max(1, Math.floor(cores / sharers));
    }
}

module.exports = { Semaphore };
