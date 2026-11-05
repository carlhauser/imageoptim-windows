'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { Job } = require('./job');
const { Semaphore } = require('./semaphore');
const { BatchTracker, describeBatch } = require('./eta');
const tools = require('./tools');
const { EXTENSIONS } = require('./filetype');
const { statKey, profileFor, satisfies } = require('./history');
const { isOriginalsDir, isInOriginals, ORIGINALS_DIR } = require('./originals');

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

// Locates an optimizer. Tools whose executable is missing are skipped rather
// than treated as an error, so a partial build still optimizes what it can.
// scriptDirs: where to look first for a script such as svgo.js. The packaged
// app keeps it inside app.asar, where the asar integrity check covers it.
function makeResolver(binDir, { scriptDirs = [] } = {}) {
    const resourcesDir = path.dirname(binDir);
    const cache = new Map();

    return function resolveTool(tool) {
        if (cache.has(tool.id)) return cache.get(tool.id);

        let resolved = null;

        if (tool.script) {
            const dirs = [...scriptDirs, resourcesDir, binDir];
            for (const candidate of dirs.map((dir) => path.join(dir, tool.script))) {
                if (fs.existsSync(candidate)) {
                    resolved = { script: candidate };
                    break;
                }
            }
        } else {
            const candidate = path.join(binDir, tool.exe + EXE_SUFFIX);
            if (fs.existsSync(candidate)) {
                resolved = { exe: candidate };
            }
            // Executables a tool runs besides its own, such as avifdec for
            // avifenc: without every one of them the tool is as good as absent
            if (resolved && tool.helpers) {
                const helpers = {};
                for (const name of tool.helpers) {
                    const helper = path.join(binDir, name + EXE_SUFFIX);
                    if (!fs.existsSync(helper)) {
                        resolved = null;
                        break;
                    }
                    helpers[name] = helper;
                }
                if (resolved) resolved.helpers = helpers;
            }
        }

        cache.set(tool.id, resolved);
        return resolved;
    };
}

// What identifies a file in the list. Two spellings of one file must not
// become two jobs racing to overwrite it, and NTFS ignores case, while 8.3
// short names, junctions, subst drives and mapped drives all give one file
// other names. The resolved path is used, in lower case on Windows.
const keyCase = (real) => (process.platform === 'win32' ? real.toLowerCase() : real);

function fileKey(filePath) {
    let real = path.resolve(filePath);
    try {
        real = fs.realpathSync.native(real);
    } catch (err) {
        /* gone or unreadable: its literal path will do */
    }
    return keyCase(real);
}

// The same, without blocking: adding a folder of 20,000 files resolves 20,000
// paths, and the main process is what keeps the window responsive.
async function fileKeyAsync(filePath) {
    let real = path.resolve(filePath);
    try {
        real = await fs.promises.realpath(real);
    } catch (err) {
        /* gone or unreadable: its literal path will do */
    }
    return keyCase(real);
}

// Runs fn over items with at most `limit` running at once, keeping the order
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(lanes);
    return results;
}

const isImageName = (name) => EXTENSIONS.includes(path.extname(name).toLowerCase());

// Port of DirScanner.m: dropping a folder queues every image inside it.
//
// Asynchronous, because this runs inside the main process and a synchronous walk
// of a deep tree freezes the window. Directories are tracked by their resolved
// path: a junction or symlink pointing back up its own tree used to be followed
// forever, and because such a cycle contains no new images the file-count cap
// never stopped it either.
//
// A folder's entries say whether each is a file or a folder, so only what was
// passed in, and links, are looked up one by one; files are picked by name.
// Every entry used to be stat'ed in turn, images or not.
//
// Returns the files found, with `truncated` set on the array when there were
// more than `limit`. onProgress(count) hears as they are found; a signal stops
// the walk where it is.
async function expandPaths(inputPaths, { limit = 20000, signal = null, onProgress = null } = {}) {
    const files = [];
    const seenFiles = new Set();
    const seenDirs = new Set();
    const pending = [...inputPaths]; // folders, and anything not yet looked at
    let truncated = false;
    let ignored = 0; // files that are not images, to say so when nothing else came

    const addFile = (filePath) => {
        const key = path.resolve(filePath);
        if (seenFiles.has(key)) return;
        seenFiles.add(key);
        if (files.length >= limit) {
            truncated = true;
            return;
        }
        files.push(key);
        if (onProgress) onProgress(files.length);
    };

    while (pending.length && !truncated) {
        if (signal && signal.aborted) break;
        const current = pending.shift();
        let stat;
        try {
            stat = await fs.promises.stat(current);
        } catch (err) {
            continue;
        }

        if (stat.isFile()) {
            if (isImageName(current)) addFile(current);
            else ignored += 1;
            continue;
        }
        if (!stat.isDirectory()) continue;

        let real = current;
        try {
            real = await fs.promises.realpath(current);
        } catch (err) {
            /* unresolvable: fall back to the literal path */
        }
        if (seenDirs.has(real)) continue;
        seenDirs.add(real);

        let entries = [];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch (err) {
            continue;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const entryPath = path.join(current, entry.name);
            if (entry.isFile()) {
                if (isImageName(entry.name)) addFile(entryPath);
                else ignored += 1;
            } else if (entry.isDirectory()) {
                // Kept originals are never optimized (Keep originals)
                if (!isOriginalsDir(entry.name)) pending.push(entryPath);
            } else if (entry.isSymbolicLink()) {
                // A link or junction: whether it leads to a file or a folder
                // is only known by following it
                pending.push(entryPath);
            }
            if (truncated) break;
        }
    }

    files.truncated = truncated;
    files.ignored = ignored;
    return files;
}

class Queue extends EventEmitter {
    constructor(options) {
        super();
        this.settings = options.settings;
        this.resolveTool = makeResolver(options.binDir, { scriptDirs: options.scriptDirs || [] });
        this.binDir = options.binDir;
        this.jobs = new Map();
        this.pending = [];
        this.running = 0;
        this.controller = null;
        this.controllers = new Map(); // job id -> AbortController, for per-job stop
        this.semaphore = new Semaphore(this.workerLimit());
        this.now = options.now || Date.now;
        this.history = options.history || null;
        // Bumped by Stop and Clear, so that a folder still being scanned when
        // they happen adds nothing afterwards
        this.generation = 0;
        // Time left for the files queued since the queue was last empty
        this.batch = new BatchTracker({ now: this.now });
    }

    // Puts a job at the back of the queue and into the current batch
    enqueue(job) {
        this.pending.push(job);
        job.waiting = true;
        job.setState('queued');
        this.batch.enqueue(job.id, job.costClass(this.settings.all()), job.bestSize || job.originalSize);
    }

    // The job for a file, however its path is spelled
    find(filePath) {
        return this.jobs.get(fileKey(filePath)) || null;
    }

    // Takes a job out of the list. Its events stop at once - a run still
    // finishing would otherwise put its row back - and a running job's temp
    // files are cleaned up when its run settles (see pump), since deleting them
    // under it could race with what it is still doing.
    discard(job) {
        job.removeAllListeners('change');
        this.jobs.delete(job.id);
        if (!job.isRunning) job.cleanup();
    }

    // Reports which optimizers are actually present, for the UI to show.
    installedTools() {
        const seen = new Map();
        for (const tool of tools.ALL) {
            const key = tool.exe || tool.script;
            if (!seen.has(key)) {
                seen.set(key, {
                    name: tool.label,
                    key,
                    installed: Boolean(this.resolveTool(tool)),
                });
            }
            for (const helper of tool.helpers || []) {
                if (seen.has(helper)) continue;
                seen.set(helper, {
                    name: helper,
                    key: helper,
                    installed: fs.existsSync(path.join(this.binDir, helper + EXE_SUFFIX)),
                });
            }
        }
        return [...seen.values()];
    }

    // Adds files and folders. A scan that Stop or Clear interrupts is dropped:
    // the files it found must not turn up afterwards.
    async add(inputPaths) {
        const generation = this.generation;
        const stale = () => generation !== this.generation;
        const files = await expandPaths(inputPaths, {
            onProgress: (found) => this.emit('scan', { found, done: false }),
        });
        this.emit('scan', {
            found: files.length, ignored: files.ignored || 0, done: true, truncated: Boolean(files.truncated),
        });
        if (stale()) return { added: 0, truncated: false };

        // Each file's identity and size, a few dozen at a time
        const found = await mapLimit(files, 24, async (filePath) => {
            const [id, stat] = await Promise.all([
                fileKeyAsync(filePath),
                fs.promises.stat(filePath).catch(() => null),
            ]);
            return { filePath, id, stat };
        });
        if (stale()) return { added: 0, truncated: false };

        const added = [];
        for (const { filePath, id, stat } of found) {
            let job = this.jobs.get(id);
            const isNew = !job;
            if (isNew) {
                job = new Job(filePath, {
                    id,
                    resolveTool: this.resolveTool,
                    semaphore: this.semaphore,
                    estimate: (estimated) => this.batch.jobFraction(estimated.id),
                    underUtilized: () => this.pending.length + this.running < this.workerLimit(),
                    history: this.history,
                });
                // The job itself, not a snapshot: whoever listens decides when
                // to serialize it, which with thousands of files matters
                job.on('change', (changed) => this.emit('job', changed));
                this.jobs.set(id, job);
                if (isInOriginals(filePath)) {
                    // Dropped in directly, or a whole originals folder dropped:
                    // shown, so it's clear why nothing happened to it
                    job.unreadable = true;
                    job.blocked = true;
                    if (stat) job.originalSize = job.bestSize = stat.size;
                    // A note, not an error: nothing went wrong
                    job.note = {
                        text: `In “${ORIGINALS_DIR}”`,
                        detail: 'A copy Keep originals saved. Files in that folder are never optimized.',
                    };
                    job.setState('done');
                    added.push(job);
                    continue;
                }
            }
            // A new file, or one that could not be opened before and is
            // dropped again - it may have been unlocked or come back since
            if (isNew || (job.unreadable && !job.blocked)) {
                if (stat) {
                    job.originalSize = stat.size;
                    job.bestSize = job.originalSize;
                    job.unreadable = false;
                } else {
                    job.unreadable = true;
                    job.setState('error', 'Can’t open the file');
                }
            }
            added.push(job);
            // Queueing a job that is already pending or mid-run would give two
            // concurrent runs over one file, racing in save().
            if (!job.unreadable && !job.isRunning && !job.waiting) {
                // A result from this session stays on show; a file first seen
                // now goes straight to Done.
                if (this.remembered(job, stat)) {
                    if (job.state !== 'done') job.markSkipped();
                } else {
                    this.enqueue(job);
                }
            }
        }

        if (added.length) {
            this.sortPending();
            this.start();
        }
        // Counts only: the window hears about each file through its events
        return { added: added.length, truncated: Boolean(files.truncated) };
    }

    snapshot() {
        return [...this.jobs.values()].map((job) => job.toJSON());
    }

    // Optimized before and not changed since, recognised from its directory
    // entry alone. Anything less certain is left to the job, which hashes the
    // content before it starts work.
    remembered(job, stat) {
        if (!this.history || !this.settings.get('SkipOptimized') || !stat) return false;
        try {
            const entry = this.history.findByStat(statKey(job.filePath, stat));
            return satisfies(entry, profileFor(entry && entry.t, this.settings.all()));
        } catch (err) {
            return false;
        }
    }

    // Reorders what has not started yet. Jobs already running are left alone.
    sortPending() {
        const order = this.settings.get('QueueOrder');
        if (order === 'smallest') {
            this.pending.sort((a, b) => a.originalSize - b.originalSize);
        } else if (order === 'largest') {
            this.pending.sort((a, b) => b.originalSize - a.originalSize);
        }
    }

    start() {
        if (!this.controller || this.controller.signal.aborted) {
            this.controller = new AbortController();
        }
        this.pump();
    }

    workerLimit() {
        const configured = Number(this.settings.get('MaxWorkers'));
        return Math.max(1, configured || os.cpus().length);
    }

    pump() {
        // Keep at least as many files open as there are worker slots, so a file
        // whose turn it is to run one slow optimizer never leaves cores idle.
        // The semaphore, not this number, is what actually caps the CPU load.
        const limit = this.workerLimit();
        this.semaphore.setLimit(limit);

        while (this.running < limit && this.pending.length) {
            const job = this.pending.shift();
            job.waiting = false;
            this.running += 1;

            // Each job gets its own controller as well as the batch one, so a
            // single row can be cancelled - by removing it - without stopping
            // everything else.
            const perJob = new AbortController();
            this.controllers.set(job.id, perJob);
            const signal = AbortSignal.any([this.controller.signal, perJob.signal]);

            this.batch.started(job.id);

            job.run(this.settings.all(), signal)
                .catch((err) => job.setState('error', err.message))
                .finally(() => {
                    // The same file may have been removed and added again while
                    // this ran, and then the id belongs to its new job
                    if (this.controllers.get(job.id) === perJob) this.controllers.delete(job.id);
                    this.running -= 1;
                    if (this.jobs.get(job.id) === job) {
                        this.batch.finished(job.id, {
                            learn: job.state === 'done' && job.toolsTotal > 0 && !signal.aborted,
                            cls: job.costClassName,
                            bytes: job.costBytes,
                        });
                    } else {
                        job.cleanup(); // removed or cleared while it ran
                    }
                    if (!this.pending.length && this.running === 0) this.batch.end();
                    this.emit('progress');
                    if (this.pending.length) {
                        this.pump();
                    } else if (this.running === 0) {
                        this.emit('idle', this.stats());
                    }
                });
        }

        this.emit('progress');
    }

    stop() {
        this.generation += 1;
        // Files still waiting are stopped too, so they leave the Queue tab
        // along with the ones that were running.
        for (const job of this.pending) {
            job.waiting = false;
            job.setState('stopped');
        }
        this.pending.length = 0;
        this.batch.end();
        if (this.controller) this.controller.abort();
        for (const controller of this.controllers.values()) controller.abort();
        this.emit('progress');
    }

    clear() {
        this.stop();
        // discard() also removes the backup copy of each original, which used
        // to be left in the temp directory forever.
        for (const job of [...this.jobs.values()]) this.discard(job);
        this.emit('progress');
    }

    remove(ids) {
        const removed = new Set();
        for (const id of ids) {
            const job = this.jobs.get(id);
            if (!job) continue;
            // Cancel first. Without this the job kept running, held its worker
            // slot, and still wrote its result over a file the user had just
            // taken out of the list.
            const controller = this.controllers.get(id);
            if (controller) controller.abort();
            removed.add(job);
            job.waiting = false;
            this.batch.drop(id);
            this.discard(job);
        }
        if (removed.size) this.pending = this.pending.filter((job) => !removed.has(job));
        this.emit('progress');
    }

    // Re-runs everything with the current settings, the way the macOS app does
    // when the optimizer preferences change.
    again() {
        for (const job of this.jobs.values()) {
            if (job.isRunning || job.waiting || job.blocked) continue;
            job.force = true;
            this.enqueue(job);
        }
        this.sortPending();
        this.start();
    }

    // Optimize Again for chosen files only - the right-click menu, or the
    // files under Skipped - rather than the whole list
    againIds(ids) {
        for (const id of ids) {
            const job = this.jobs.get(id);
            if (!job || job.isRunning || job.waiting || job.blocked || job.unreadable) continue;
            job.force = true;
            this.enqueue(job);
        }
        this.sortPending();
        this.start();
    }

    // Stops chosen files: those waiting leave the queue, those running are
    // stopped where they are, and the rest carry on.
    stopIds(ids) {
        const stopped = new Set();
        for (const id of ids) {
            const job = this.jobs.get(id);
            if (!job) continue;
            if (job.waiting) {
                job.waiting = false;
                stopped.add(job);
                this.batch.drop(id);
                job.setState('stopped');
            }
            const controller = this.controllers.get(id);
            if (controller) controller.abort();
        }
        if (stopped.size) this.pending = this.pending.filter((job) => !stopped.has(job));
        this.emit('progress');
        // Nothing running to settle and announce it: the queue is idle now
        if (!this.isBusy()) {
            this.batch.end();
            this.emit('idle', this.stats());
        }
    }

    revert(id) {
        const job = this.jobs.get(id);
        if (!job) return { ok: false, reason: 'that file is no longer in the list' };
        // A run in progress would finish by marking the file done and
        // overwrite "reverted", and a queued one would optimize it again
        if (job.isRunning || job.waiting) {
            return { ok: false, reason: 'it is being optimized; stop it first' };
        }
        return job.revert(this.settings.all());
    }

    // True while any file is queued, being optimized or being saved. running is
    // only decremented once a job's run() has settled, which includes its save,
    // so this stays true until the original has been replaced. The updater will
    // not restart the app while it is.
    isBusy() {
        return this.running > 0 || this.pending.length > 0;
    }

    // Files whose original exists only as this session's temp copy: Revert can
    // restore them until the list is cleared or the app quits, and not after.
    // A copy in "ImageOptim originals" is the user's and outlives both.
    revertableCount() {
        let count = 0;
        for (const job of this.jobs.values()) {
            if (job.backupPath && !job.backupIsKept) count += 1;
        }
        return count;
    }

    runningJobs() {
        return [...this.jobs.values()].filter((job) => job.state === 'running');
    }

    stats() {
        let originalTotal = 0;
        let bestTotal = 0;
        let optimized = 0;
        let busy = 0;
        let skipped = 0;
        let failed = 0;
        let maxPercent = 0;

        for (const job of this.jobs.values()) {
            originalTotal += job.originalSize;
            bestTotal += job.bestSize || job.originalSize;
            if (job.isOptimized) optimized += 1;
            if (job.state === 'running' || job.state === 'queued') busy += 1;
            if (job.state === 'skipped') skipped += 1;
            if (job.state === 'error') failed += 1;
            maxPercent = Math.max(maxPercent, job.percentOptimized);
        }

        return {
            files: this.jobs.size,
            optimized,
            busy,
            skipped,
            failed,
            maxPercent,
            running: this.running,
            queued: this.pending.length,
            originalTotal,
            bestTotal,
            savedBytes: Math.max(0, originalTotal - bestTotal),
            savedPercent: originalTotal ? Math.max(0, (1 - bestTotal / originalTotal) * 100) : 0,
            batch: this.batchProgress(),
        };
    }

    // The progress bar and time left: null while nothing is queued
    batchProgress() {
        if (!this.isBusy() || !this.batch.active) return null;
        const snapshot = this.batch.snapshot(this.workerLimit());
        return snapshot && { ...snapshot, ...describeBatch(snapshot) };
    }
}

module.exports = { Queue, expandPaths, makeResolver, fileKey, mapLimit };
