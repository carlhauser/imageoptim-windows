'use strict';

// How long the files in the queue will take, for the progress bar along the
// bottom of the window and the time-left text beside it.
//
// Time per file is learned, not assumed from size alone. A small PNG that
// Zopfli works on takes about as long as a much larger one that only OxiPNG
// sees, JPEGs are cheap, and Guetzli takes minutes - so durations are fitted
// per cost class (the format plus the slow optimizers that apply, see
// Job.costClass), each as duration = a + b * bytes. Smallest-first, the
// default order, means the first files to finish are exactly the expensive
// ones per byte; a single bytes-per-second rate would be badly off.

// A least-squares line through (bytes, milliseconds), kept as running sums.
class Fit {
    constructor() {
        this.n = 0;
        this.sx = 0;
        this.sy = 0;
        this.sxx = 0;
        this.sxy = 0;
    }

    add(x, y) {
        this.n += 1;
        this.sx += x;
        this.sy += y;
        this.sxx += x * x;
        this.sxy += x * y;
    }

    // Through the origin: time in proportion to size
    proportional(x) {
        return this.sxx > 0 ? (this.sxy / this.sxx) * x : this.sy / this.n;
    }

    predict(x) {
        if (!this.n) return null;
        // Too few points, or all the same size, to tell a slope from noise:
        // assume time in proportion to size, which at least knows that a
        // file ten times larger is slower than the small ones seen so far.
        const varX = this.sxx - (this.sx * this.sx) / this.n;
        if (this.n < 3 || varX <= 1e-9 * (this.sxx || 1)) return this.proportional(x);

        const b = (this.sxy - (this.sx * this.sy) / this.n) / varX;
        const a = (this.sy - b * this.sx) / this.n;
        // A file never gets quicker by being larger, and never takes less
        // than nothing
        if (b < 0 || a < 0) return this.proportional(x);
        return a + b * x;
    }
}

// How quickly the shown finish time follows a new estimate: an exponential
// average with this time constant, so the countdown neither jumps about as
// files finish nor stops between updates.
const SMOOTHING_MS = 3000;

// Until this many files have finished, a format that has not been seen yet is
// still "estimating" rather than guessed from the others.
const POOLED_MIN = 3;

// What is left of a file that has run for `elapsed` of a predicted `pred`.
// Once it passes two thirds of the prediction the prediction was evidently
// short, and a file that has already run long tends to run longer still: the
// remainder is taken as half the time spent so far. That grows while it runs,
// which is honest, where "a few seconds left" for a whole minute is not.
function timeLeftOf(elapsed, pred) {
    return Math.max(pred - elapsed, elapsed / 2);
}

// The row line's version: it follows the clock while on schedule, then keeps
// creeping on (80% at the crossover, 90% at four times the prediction) so an
// overrunning file looks busy rather than stuck.
function rowFraction(elapsed, pred) {
    return elapsed / (elapsed + Math.max(pred - elapsed, 0.2236 * Math.sqrt(elapsed * pred)));
}

class BatchTracker {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.models = new Map(); // cost class -> Fit, kept for the whole session
        this.pooled = new Fit();
        this.entries = new Map(); // job id -> { cls, bytes, startedAt, finished }
        this.lastFraction = 0;
        this.grown = false;
        this.smoothFinish = null;
        this.smoothAt = 0;
    }

    get active() {
        return this.entries.size > 0;
    }

    // A file joins the current batch, or starts a new one. Learned durations
    // carry over between batches.
    enqueue(id, cls, bytes) {
        const existing = this.entries.get(id);
        if (existing && !existing.finished) {
            existing.cls = cls;
            existing.bytes = bytes;
            return;
        }
        this.entries.set(id, { cls, bytes, startedAt: null, finished: false });
        this.grown = true;
    }

    started(id) {
        const entry = this.entries.get(id);
        if (entry) entry.startedAt = this.now();
    }

    // learn: the run did the normal amount of work and ended normally. A file
    // that failed, was stopped or had nothing to do teaches nothing.
    finished(id, { learn = false, cls, bytes } = {}) {
        const entry = this.entries.get(id);
        if (!entry || entry.finished) return;
        if (cls) entry.cls = cls;
        if (bytes) entry.bytes = bytes;
        entry.finished = true;

        if (learn && entry.startedAt !== null) {
            const ms = Math.max(1, this.now() - entry.startedAt);
            if (!this.models.has(entry.cls)) this.models.set(entry.cls, new Fit());
            this.models.get(entry.cls).add(entry.bytes, ms);
            this.pooled.add(entry.bytes, ms);
        }
    }

    // Taken out of the list before it finished
    drop(id) {
        this.entries.delete(id);
    }

    // The queue has emptied, been stopped or been cleared
    end() {
        this.entries.clear();
        this.lastFraction = 0;
        this.grown = false;
        this.smoothFinish = null;
    }

    predict(cls, bytes) {
        const model = this.models.get(cls);
        if (model && model.n) return model.predict(bytes);
        return this.pooled.predict(bytes);
    }

    // How far along a running file is, by time, or null with nothing to go
    // on. Its row line shows this. Any file finished so far is better than
    // nothing here, so this is looser than the batch's "estimating".
    jobFraction(id) {
        const entry = this.entries.get(id);
        if (!entry || entry.finished || entry.startedAt === null) return null;
        const pred = this.predict(entry.cls, entry.bytes);
        if (!pred) return null;
        return rowFraction(Math.max(0, this.now() - entry.startedAt), pred);
    }

    // parallelism: how many files run at once (the queue's worker limit).
    snapshot(parallelism = 1) {
        const now = this.now();
        let total = 0;
        let done = 0;
        let unfinished = 0;
        let estimating = false;
        let workTotal = 0;
        let workDone = 0;
        let remaining = 0;
        let longest = 0;

        for (const entry of this.entries.values()) {
            total += 1;
            const known = this.models.has(entry.cls) || this.pooled.n >= POOLED_MIN;
            const pred = known ? this.predict(entry.cls, entry.bytes) : null;

            if (entry.finished) {
                done += 1;
                if (pred !== null) {
                    workTotal += pred;
                    workDone += pred;
                }
                continue;
            }

            unfinished += 1;
            if (pred === null) {
                estimating = true;
                continue;
            }

            if (entry.startedAt !== null) {
                const elapsed = Math.max(0, now - entry.startedAt);
                const left = timeLeftOf(elapsed, pred);
                remaining += left;
                longest = Math.max(longest, left);
                workTotal += elapsed + left;
                workDone += elapsed;
            } else {
                workTotal += pred;
                remaining += pred;
            }
        }

        if (!total) return null;

        // Before anything is known, the bar counts files instead of time
        let fraction = estimating || !workTotal ? done / total : workDone / workTotal;
        fraction = Math.min(1, Math.max(0, fraction));
        // Never backwards, unless files were added since the last look
        if (!this.grown) fraction = Math.max(fraction, this.lastFraction);
        this.lastFraction = fraction;
        this.grown = false;

        let remainingMs = null;
        if (!estimating && unfinished) {
            const slots = Math.max(1, Math.min(parallelism, unfinished));
            const target = now + Math.max(remaining / slots, longest);
            if (this.smoothFinish === null) {
                this.smoothFinish = target;
            } else {
                const weight = 1 - Math.exp(-Math.max(0, now - this.smoothAt) / SMOOTHING_MS);
                this.smoothFinish += (target - this.smoothFinish) * weight;
            }
            this.smoothAt = now;
            remainingMs = Math.max(0, this.smoothFinish - now);
        } else if (estimating) {
            this.smoothFinish = null;
        }

        return { total, done, fraction, estimating, remainingMs };
    }
}

function timeLeft(ms) {
    const seconds = ms / 1000;
    if (seconds < 10) return 'a few seconds left';
    if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} s left`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `about ${minutes} min left`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `about ${hours} h ${rest} min left` : `about ${hours} h left`;
}

// The status bar's wording. Kept here, beside the numbers, so it is tested.
function describeBatch(batch) {
    if (!batch) return null;
    const count = `${batch.done} of ${batch.total} done`;
    let left = '';
    if (batch.estimating) left = 'estimating time left…';
    else if (batch.remainingMs !== null) left = timeLeft(batch.remainingMs);
    return {
        text: left ? `${count} · ${left}` : count,
        ariaText: left ? `${count}, ${left.replace('…', '')}` : count,
    };
}

module.exports = { BatchTracker, Fit, describeBatch, timeLeft };
