'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { Job } = require('./job');
const { Semaphore } = require('./semaphore');
const tools = require('./tools');
const { EXTENSIONS } = require('./filetype');

const EXE_SUFFIX = process.platform === 'win32' ? '.exe' : '';

// Locates an optimizer. Tools whose executable is missing are skipped rather
// than treated as an error, so a partial build still optimizes what it can.
function makeResolver(binDir) {
    const resourcesDir = path.dirname(binDir);
    const cache = new Map();

    return function resolveTool(tool) {
        if (cache.has(tool.id)) return cache.get(tool.id);

        let resolved = null;

        if (tool.script) {
            for (const candidate of [path.join(resourcesDir, tool.script), path.join(binDir, tool.script)]) {
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
        }

        cache.set(tool.id, resolved);
        return resolved;
    };
}

// Port of DirScanner.m: dropping a folder queues every image inside it.
//
// Asynchronous, because this runs inside the main process and a synchronous walk
// of a deep tree freezes the window. Directories are tracked by their resolved
// path: a junction or symlink pointing back up its own tree used to be followed
// forever, and because such a cycle contains no new images the file-count cap
// never stopped it either.
async function expandPaths(inputPaths, limit = 20000) {
    const files = [];
    const seenFiles = new Set();
    const seenDirs = new Set();
    const pending = [...inputPaths];

    while (pending.length && files.length < limit) {
        const current = pending.shift();
        let stat;
        try {
            stat = await fs.promises.stat(current);
        } catch (err) {
            continue;
        }

        if (stat.isDirectory()) {
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
                pending.push(path.join(current, entry.name));
            }
            continue;
        }

        if (!stat.isFile()) continue;
        if (!EXTENSIONS.includes(path.extname(current).toLowerCase())) continue;

        const key = path.resolve(current);
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        files.push(key);
    }

    return files;
}

class Queue extends EventEmitter {
    constructor(options) {
        super();
        this.settings = options.settings;
        this.resolveTool = makeResolver(options.binDir);
        this.binDir = options.binDir;
        this.jobs = new Map();
        this.pending = [];
        this.running = 0;
        this.controller = null;
        this.controllers = new Map(); // job id -> AbortController, for per-job stop
        this.semaphore = new Semaphore(this.workerLimit());
    }

    // Reports which optimizers are actually present, for the UI to show.
    installedTools() {
        const seen = new Map();
        for (const tool of tools.ALL) {
            const key = tool.exe || tool.script;
            if (seen.has(key)) continue;
            seen.set(key, {
                name: tool.label,
                key,
                installed: Boolean(this.resolveTool(tool)),
            });
        }
        return [...seen.values()];
    }

    async add(inputPaths) {
        const files = await expandPaths(inputPaths);
        const added = [];

        for (const filePath of files) {
            let job = this.jobs.get(filePath);
            if (!job) {
                job = new Job(filePath, { resolveTool: this.resolveTool, semaphore: this.semaphore });
                job.on('change', (snapshot) => this.emit('job', snapshot));
                this.jobs.set(filePath, job);
                try {
                    job.originalSize = fs.statSync(filePath).size;
                    job.bestSize = job.originalSize;
                    job.unreadable = false;
                } catch (err) {
                    job.unreadable = true;
                    job.setState('error', 'Can’t open the file');
                }
            }
            added.push(job);
            // Queueing a job that is already pending or mid-run would give two
            // concurrent runs over one file, racing in save().
            if (!job.unreadable && !job.isRunning && !this.pending.includes(job)) {
                this.pending.push(job);
                job.setState('queued');
            }
        }

        if (added.length) {
            this.sortPending();
            this.start();
        }
        return added.map((job) => job.toJSON());
    }

    snapshot() {
        return [...this.jobs.values()].map((job) => job.toJSON());
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
            this.running += 1;

            // Each job gets its own controller as well as the batch one, so a
            // single row can be cancelled - by removing it - without stopping
            // everything else.
            const perJob = new AbortController();
            this.controllers.set(job.filePath, perJob);
            const signal = AbortSignal.any([this.controller.signal, perJob.signal]);

            job.run(this.settings.all(), signal)
                .catch((err) => job.setState('error', err.message))
                .finally(() => {
                    this.controllers.delete(job.filePath);
                    this.running -= 1;
                    this.emit('progress', this.stats());
                    if (this.pending.length) {
                        this.pump();
                    } else if (this.running === 0) {
                        this.emit('idle', this.stats());
                    }
                });
        }

        this.emit('progress', this.stats());
    }

    stop() {
        this.pending.length = 0;
        if (this.controller) this.controller.abort();
        for (const controller of this.controllers.values()) controller.abort();
        this.emit('progress', this.stats());
    }

    clear() {
        this.stop();
        // cleanup() now also removes the backup copy of each original, which
        // used to be left in the temp directory forever.
        for (const job of this.jobs.values()) job.cleanup();
        this.jobs.clear();
        this.emit('progress', this.stats());
    }

    remove(ids) {
        for (const id of ids) {
            const job = this.jobs.get(id);
            if (!job) continue;
            // Cancel first. Without this the job kept running, held its worker
            // slot, and still wrote its result over a file the user had just
            // taken out of the list.
            const controller = this.controllers.get(id);
            if (controller) controller.abort();
            this.pending = this.pending.filter((pendingJob) => pendingJob !== job);
            this.jobs.delete(id);
            if (!job.isRunning) job.cleanup();
        }
        this.emit('progress', this.stats());
    }

    // Re-runs everything with the current settings, the way the macOS app does
    // when the optimizer preferences change.
    again() {
        for (const job of this.jobs.values()) {
            if (job.isRunning || this.pending.includes(job)) continue;
            this.pending.push(job);
            job.setState('queued');
        }
        this.sortPending();
        this.start();
    }

    revert(id) {
        const job = this.jobs.get(id);
        if (!job) return { ok: false, reason: 'that file is no longer in the list' };
        return job.revert(this.settings.all());
    }

    stats() {
        let originalTotal = 0;
        let bestTotal = 0;
        let optimized = 0;
        let busy = 0;

        for (const job of this.jobs.values()) {
            originalTotal += job.originalSize;
            bestTotal += job.bestSize || job.originalSize;
            if (job.isOptimized) optimized += 1;
            if (job.state === 'running' || job.state === 'queued') busy += 1;
        }

        return {
            files: this.jobs.size,
            optimized,
            busy,
            running: this.running,
            queued: this.pending.length,
            originalTotal,
            bestTotal,
            savedBytes: Math.max(0, originalTotal - bestTotal),
            savedPercent: originalTotal ? Math.max(0, (1 - bestTotal / originalTotal) * 100) : 0,
        };
    }
}

module.exports = { Queue, expandPaths, makeResolver };
