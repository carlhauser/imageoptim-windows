'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tools = require('./tools');
const { hashFile, statKey, profileFor, satisfies } = require('./history');
const { keepOriginal, removeIfEmpty, sameContent } = require('./originals');
const { looksComplete, hasRoomFor } = require('./validate');
const { Semaphore } = require('./semaphore');
const { describeFsError } = require('./errors');
const {
    detectType, inspect, typeFromExtension, isSmall, HEADER_BYTES, PNG, JPEG, GIF, SVG, WEBP, AVIF,
} = require('./filetype');

let tempCounter = 0;
let tempRoot = null;

// The cores the optimizers share (lib/semaphore.js threadsPerSlot)
const CORES = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;

// Tools marked exclusive (Guetzli) run one at a time across every file
const gates = new Map();
function gateFor(tool) {
    if (!tool.exclusive) return null;
    if (!gates.has(tool.id)) gates.set(tool.id, new Semaphore(1));
    return gates.get(tool.id);
}

// Everything scratch lives in one directory we own, so a crash leaves a single
// identifiable folder and startup can reclaim it. Writing loose files straight
// into %TEMP% meant orphans nothing ever cleaned up.
function tempDir() {
    if (!tempRoot) {
        tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ImageOptim-'));
    }
    return tempRoot;
}

// The .temp suffix is deliberate and load-bearing. advpng refuses a file named
// *.tmp outright - "Error reading the signature" - while .temp, .png and even no
// extension are all fine. Renaming these would disable advpng silently, since a
// tool that exits non-zero is simply reported as no improvement. There is a
// regression test for this in test/binaries.test.js.
function tempPath(toolId) {
    tempCounter += 1;
    const unique = `${process.pid.toString(16)}.${tempCounter.toString(16)}`;
    return path.join(tempDir(), `${toolId}.${unique}.temp`);
}

// Removes scratch directories left behind by a previous run that was killed.
// Called shortly after startup; asynchronous, since %TEMP% can be large and
// the main process is what keeps the window responsive.
async function sweepTempDirs() {
    let entries = [];
    try {
        entries = await fs.promises.readdir(os.tmpdir(), { withFileTypes: true });
    } catch (err) {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('ImageOptim-')) continue;
        const dir = path.join(os.tmpdir(), entry.name);
        if (dir === tempRoot) continue; // ours, still in use
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
        } catch (err) {
            /* another instance may still own it */
        }
    }
}

function releaseTempDir() {
    if (!tempRoot) return;
    try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (err) {
        /* best effort on the way out */
    }
    tempRoot = null;
}

function unlinkQuietly(filePath) {
    if (!filePath) return;
    try {
        fs.unlinkSync(filePath);
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn('Could not remove temp file:', err.message);
    }
}

// What Windows says, briefly, when a file another program has open cannot be
// replaced. Antivirus scanners, the search indexer, OneDrive and thumbnailers
// all hold an image for a moment after it changes, so these usually clear up.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

// How hard replaceOriginal tries before giving up on the atomic rename. The
// waits add up to about 1.4 s. Tests turn the delay down.
const RENAME_RETRY = { attempts: 8, delayMs: 50 };

// A blocking wait. save() stays synchronous on purpose, so that Stop, Clear
// and quitting can never land halfway through writing over an original; the
// cost is that a retry holds the main process for its few hundred ms, and
// that only happens when a rename has already failed.
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to) {
    for (let attempt = 1; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (err) {
            if (attempt >= RENAME_RETRY.attempts || !TRANSIENT.has(err.code)) throw err;
            sleepSync(RENAME_RETRY.delayMs * attempt);
        }
    }
}

// The session's backups, which Revert puts back, each as big as the file it
// stands for: a hard link costs no copying, but it keeps the original's data
// alive once the optimized file has taken its name. Past this budget, newly
// optimized files keep no backup and cannot be reverted, rather than 20,000
// photos filling the drive with tens of gigabytes. Copies kept in "ImageOptim
// originals" are the user's and do not count.
const BACKUPS = { budget: 2 * 1024 * 1024 * 1024, used: 0 };

// A backup made as a second name for the original's data where that is
// possible - the temp folder on the same drive, and the file with no other
// names of its own, whose data someone could still change - and as a copy
// otherwise. Returns true for a link.
function linkOrCopy(from, to, stat) {
    if (stat && stat.nlink === 1) {
        try {
            fs.linkSync(from, to);
            return true;
        } catch (err) {
            /* another drive, FAT, a network share: copy */
        }
    }
    fs.copyFileSync(from, to);
    return false;
}

// "photo (ImageOptim backup).png", or "(2)" and so on if that is taken
function rescueName(dir, file) {
    const ext = path.extname(file);
    const base = path.basename(file, ext);
    for (let n = 1; n <= 99; n++) {
        const name = n === 1 ? `${base} (ImageOptim backup)${ext}` : `${base} (ImageOptim backup ${n})${ext}`;
        const candidate = path.join(dir, name);
        if (!fs.existsSync(candidate)) return candidate;
    }
    return null;
}

// Why a WebP or AVIF file got no optimizer: short enough for the Savings
// column, with the reason in full for its tooltip.
const NOTES = {
    lossyWebP: {
        text: 'Lossy minification off',
        detail: 'A lossy WebP can only be made smaller by re-encoding it, which needs Lossy minification on (Settings, Options).',
    },
    lossyAvif: {
        text: 'Lossy minification off',
        detail: 'AVIF has no lossless optimizer: it is re-encoded only with Lossy minification on (Settings, Options).',
    },
    animatedWebP: {
        text: 'Animated: left as is',
        detail: 'cwebp cannot re-encode an animated WebP, and it has no EXIF or XMP to strip.',
    },
    animatedAvif: {
        text: 'Animated: left as is',
        detail: 'Re-encoding would keep only the first frame of the animation.',
    },
    gainMap: {
        text: 'Gain map: left as is',
        detail: 'This AVIF has an HDR gain map, which re-encoding would lose.',
    },
};

// A single image being optimized. Ports Job.m: pick the applicable optimizers,
// run the destructive ones first and one at a time, then race the lossless ones,
// and keep whichever output turned out smallest.
class Job extends EventEmitter {
    constructor(filePath, options) {
        super();
        this.filePath = filePath;
        // How the queue and the window know this file (lib/queue.js fileKey)
        this.id = options.id || filePath;
        this.name = path.basename(filePath);
        this.resolveTool = options.resolveTool;
        this.semaphore = options.semaphore;
        // From the queue: how far along this file is by time, or null
        this.estimate = options.estimate || null;
        this.history = options.history || null; // lib/history.js, if any
        // From the queue: whether fewer files are in hand than worker slots
        this.underUtilized = options.underUtilized || null;
        this.force = false; // Again: optimize even if already optimized
        this.waiting = false; // in the queue's pending list (lib/queue.js)
        this.inputHash = null;

        this.type = null;
        this.features = null;      // lib/filetype.js inspect(): WebP and AVIF only
        this.note = null;          // why nothing was tried, when nothing was
        this.originalSize = 0;
        this.bestSize = 0;
        this.bestPath = null;      // temp file holding the best result so far
        this.bestTool = null;
        this.backupPath = null;    // pre-optimization copy, for Revert
        // Keep originals: backupPath is then the copy in "ImageOptim
        // originals", which belongs to the user and is never deleted
        this.backupIsKept = false;
        this.keptCreated = false;  // false: an identical copy was already there
        this.keptSize = 0;
        this.keptMtimeMs = 0;
        this.lastSavedSize = 0;    // size we last wrote, to spot outside edits
        this.lastSavedMtimeMs = 0; // and when, to spot a same-size edit
        this.isRunning = false;
        this.runCount = 0;
        this.state = 'queued';
        this.error = null;
        this.toolsTotal = 0;
        this.toolsDone = 0;
        this.shownProgress = 0;
        this.problems = [];        // { tool, problem } from the last run
        // Each result kept since the original: { tool, size, lossy }, so the
        // window can say "pngquant 80% → OxiPNG" rather than the last name only
        this.steps = [];
        this.activeTools = new Map(); // tool label -> how many are running
        this.startedAt = 0;
    }

    // How far along the row's progress line is. Counting finished optimizers
    // alone barely moves for a PNG - Zopfli runs on its own first and takes
    // most of the time - so once the queue can estimate this file the line
    // follows the clock, stopping short of the end until the file is done.
    // It never moves backwards within a run, even when the estimate grows.
    progressFraction() {
        if (this.state !== 'running') return this.toolsTotal ? this.toolsDone / this.toolsTotal : 0;
        const byTools = this.toolsTotal ? (this.toolsDone / this.toolsTotal) * 0.95 : 0;
        const byTime = this.estimate ? Math.min(0.95, this.estimate(this) || 0) : 0;
        this.shownProgress = Math.max(this.shownProgress, byTools, byTime);
        return this.shownProgress;
    }

    // Already optimized, as found in the history: nothing to do. A later Again
    // starts one effort level up, as it would after a run.
    markSkipped() {
        this.runCount = Math.max(1, this.runCount);
        this.bestSize = this.bestSize || this.originalSize;
        this.setState('skipped');
    }

    // Records the file as it now is on disk as optimized with these settings.
    // hash: the content's hash when already known; written: this run saved
    // that content over the original. Never fails the job.
    async remember(settings, level, { hash = null, written = false } = {}) {
        if (!this.history) return;
        try {
            const stat = fs.statSync(this.filePath);
            const contentHash = hash || await hashFile(this.filePath);
            this.history.record({
                hash: contentHash,
                key: statKey(this.filePath, stat),
                type: this.type,
                profile: profileFor(this.type, settings, { level }),
                written,
            });
        } catch (err) {
            console.warn('Could not remember an optimized file:', err.message);
        }
    }

    // Zopfli and Guetzli, which decide how long a file takes. planTools and
    // costClass both ask these, so the estimate can't drift from the plan.
    zopfliPlanned(settings, size) {
        if (!settings.ZopfliEnabled) return false;
        const skipAbove = settings.ThoroughPng ? 0 : Number(settings.ZopfliSkipAboveKB) * 1024;
        return !skipAbove || size <= skipAbove;
    }

    guetzliPlanned(settings) {
        return this.runCount === 0 && tools.byId('guetzli').enabled(settings);
    }

    // Files in the same class take about the same time for their size; see
    // lib/eta.js. Before the run the type comes from the extension.
    costClass(settings) {
        const type = this.type || typeFromExtension(this.filePath) || 'other';
        const size = this.bestSize || this.originalSize;
        const parts = [type];
        if (type === PNG && this.zopfliPlanned(settings, size)) parts.push('zopfli');
        if (type === JPEG && this.guetzliPlanned(settings)) parts.push('guetzli');
        if (settings.LossyEnabled) parts.push('lossy');
        return parts.join('+');
    }

    get percentOptimized() {
        if (!this.originalSize || !this.bestSize) return 0;
        if (this.bestSize >= this.originalSize) return 0;
        return (1 - this.bestSize / this.originalSize) * 100;
    }

    get isOptimized() {
        return Boolean(this.bestSize) && this.bestSize < this.originalSize;
    }

    // Shown in the window, so it must be cheap: every change sends it. revert()
    // still checks the backup is really there before it does anything.
    get canRevert() {
        return Boolean(this.backupPath);
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            path: this.filePath,
            type: this.type,
            originalSize: this.originalSize,
            bestSize: this.bestSize || this.originalSize,
            percentOptimized: this.percentOptimized,
            bestTool: this.bestTool,
            state: this.state,
            error: this.error,
            note: this.note ? this.note.text : null,
            noteDetail: this.note ? this.note.detail : null,
            progress: this.progressFraction(),
            canRevert: this.canRevert,
            // Optimized past the session's backup budget, so no way back
            revertLost: Boolean(this.originalLost),
            problems: this.problems.length ? this.problems.slice() : null,
            steps: this.steps.length ? this.steps.slice() : null,
            lossy: this.steps.some((step) => step.lossy),
            // While it runs: which optimizers are at work, how many are done
            // of how many, and since when
            activity: this.state === 'running' ? {
                tools: [...this.activeTools.keys()],
                done: this.toolsDone,
                total: this.toolsTotal,
                startedAt: this.startedAt,
            } : null,
        };
    }

    setState(state, error) {
        this.state = state;
        this.error = error || null;
        this.emit('change', this);
    }

    // Keeps the candidate only when it is genuinely smaller, exactly as
    // setFileOptimized:toolName: does.
    adopt(candidatePath, size, label, lossy = false) {
        if (!size || size >= this.bestSize) {
            unlinkQuietly(candidatePath);
            return false;
        }

        const previous = this.bestPath;
        this.steps.push({ tool: label, saved: this.bestSize - size, lossy: Boolean(lossy) });
        this.bestPath = candidatePath;
        this.bestSize = size;
        this.bestTool = label;
        unlinkQuietly(previous);
        this.emit('change', this);
        return true;
    }

    // Which optimizers apply, and in which order. Ports the switch in
    // doEnqueueWorkersInCPUQueue.
    // underUtilized: fewer files are waiting or running than there are worker
    // slots (lib/queue.js), so cores would otherwise sit idle.
    planTools(settings, { underUtilized = false } = {}) {
        const hasBeenRunBefore = this.runCount > 0;
        const lossyEnabled = Boolean(settings.LossyEnabled);
        let level = Number(settings.AdvPngLevel) || 4;

        const plan = [];
        let lossyConverted = false;
        // Why a file of a supported type gets no optimizer, when that is down
        // to the file rather than to switches turned off
        let note = null;

        if (this.type === PNG) {
            if (hasBeenRunBefore) level += 1;

            if (lossyEnabled && tools.byId('pngquant').enabled(settings)) {
                plan.push({ tool: tools.byId('pngquant'), first: true });
                lossyConverted = true;
            }

            let pngcrushEnabled = Boolean(settings.PngCrush2Enabled);
            const oxipngEnabled = Boolean(settings.OptiPngEnabled);

            // Pngcrush adds nothing over oxipng unless the effort level is very low
            if (level < 2 && oxipngEnabled) pngcrushEnabled = false;

            if (pngcrushEnabled) plan.push({ tool: tools.byId('pngcrush') });
            if (oxipngEnabled) plan.push({ tool: tools.byId('oxipng') });
            if (settings.AdvPngEnabled && settings.PngOutRemoveChunks) {
                plan.push({ tool: tools.byId('advpng') });
            }
            if (this.zopfliPlanned(settings, this.bestSize)) {
                plan.push({ tool: tools.byId('zopflipng'), alternativeStrategy: hasBeenRunBefore });
            }
        } else if (this.type === JPEG) {
            if (!lossyConverted && this.guetzliPlanned(settings)) {
                plan.push({ tool: tools.byId('guetzli') });
                lossyConverted = true;
            }
            if (settings.JpegOptimEnabled) plan.push({ tool: tools.byId('jpegoptim') });
            if (settings.JpegTranEnabled) plan.push({ tool: tools.byId('jpegtran') });
        } else if (this.type === GIF) {
            if (settings.GifsicleEnabled) {
                const gifQuality = Number(settings.GifQuality);
                if (lossyEnabled && !lossyConverted && gifQuality < 100 && gifQuality > 30) {
                    plan.push({ tool: tools.byId('gifsicle'), first: true, lossyGif: true });
                    lossyConverted = true;
                } else {
                    plan.push({ tool: tools.byId('gifsicle') });
                    if (level > 1) plan.push({ tool: tools.byId('gifsicle-interlaced') });
                }
            }
        } else if (this.type === SVG) {
            if (settings.SvgoEnabled) plan.push({ tool: tools.byId('svgo') });
            if (settings.SvgcleanerEnabled) plan.push({ tool: tools.byId('svgcleaner') });
        } else if (this.type === WEBP) {
            const webp = this.features || {};
            // Stripping goes first, so that the lossy pass is measured against
            // the image data alone: dropping a large XMP packet must not count
            // towards the saving a re-encode has to make.
            if (tools.byId('webpmux').enabled(settings) && (webp.exif || webp.xmp)) {
                plan.push({ tool: tools.byId('webpmux'), first: true });
            }
            // cwebp cannot decode an animation, and a lossless file stays
            // lossless: it is usually a graphic, where lossy artefacts show
            if (webp.animated) {
                note = NOTES.animatedWebP;
            } else if (webp.lossless) {
                if (settings.CwebpEnabled) plan.push({ tool: tools.byId('cwebp') });
            } else if (tools.byId('cwebp-lossy').enabled(settings)) {
                plan.push({ tool: tools.byId('cwebp-lossy'), first: true });
            } else if (settings.CwebpEnabled && !lossyEnabled) {
                note = NOTES.lossyWebP;
            }
        } else if (this.type === AVIF) {
            const avif = this.features || {};
            if (avif.animated) {
                note = NOTES.animatedAvif;
            } else if (avif.gainMap) {
                note = NOTES.gainMap;
            } else if (tools.byId('avifenc').enabled(settings)) {
                plan.push({ tool: tools.byId('avifenc'), first: true });
            } else if (settings.AvifencEnabled && !lossyEnabled) {
                note = NOTES.lossyAvif;
            }
        }

        // Optimizers that rewrite the image rather than merely recompressing it
        // have to run first, one at a time, so later tools see their output.
        //
        // Unless only a few files are being optimized: then, as in Job.m, one
        // that is first only for that reason - Zopfli, a lossy JpegOptim pass,
        // Pngcrush stripping - races the others on the same input instead, and
        // the smallest result still wins. Otherwise a handful of PNGs leaves
        // the PC on one core while Zopfli runs alone. Small files keep the
        // order, and so do steps marked first: pngquant has to feed the
        // others, and webpmux strips before a lossy re-encode is measured.
        const race = underUtilized && !isSmall(this.type, this.bestSize);
        const runFirst = [];
        const runLater = [];
        for (const step of plan) {
            const destructive = step.first
                || (step.tool.makesNonOptimizingModifications
                    ? step.tool.makesNonOptimizingModifications(settings)
                    : step.tool.lossy);
            const first = step.first || (destructive && !race);
            (first ? runFirst : runLater).push({ ...step, level });
        }

        return { runFirst, runLater, level, note: plan.length ? null : note };
    }

    async runTool(step, settings, signal) {
        const { tool } = step;
        const resolved = this.resolveTool(tool);
        if (!resolved) {
            // Not installed. Still counts as finished, or the progress fraction
            // never reaches 1 and the row looks stuck.
            this.toolsDone += 1;
            this.emit('change', this);
            return null;
        }

        // Tools do real work before they spawn anything - a full file copy, or a
        // PNG decode for Guetzli - so without this Stop still burns that work.
        if (signal.aborted) {
            this.toolsDone += 1;
            return null;
        }

        const temp = tempPath(tool.id);
        const ctx = {
            input: { path: this.bestPath || this.filePath, byteSize: this.bestSize, type: this.type },
            temp,
            settings,
            level: step.level,
            alternativeStrategy: Boolean(step.alternativeStrategy),
            lossyGif: Boolean(step.lossyGif),
            features: this.features,
            signal,
            exe: resolved.exe,
            script: resolved.script,
            helpers: resolved.helpers,
        };

        // A tool that hangs would hold its slot for good, and the batch would
        // never end. The clock starts once the tool has a slot, not while it
        // waits for one, and the tool is stopped the way Stop stops it.
        let timeout = null;
        const execute = () => {
            if (signal.aborted) return null;
            timeout = AbortSignal.timeout(tools.timeoutMs(tool, ctx));
            ctx.signal = AbortSignal.any([signal, timeout]);
            ctx.threads = this.semaphore ? this.semaphore.threadsPerSlot(CORES) : CORES;
            this.activeTools.set(tool.label, (this.activeTools.get(tool.label) || 0) + 1);
            this.emit('change', this);
            return Promise.resolve(tool.run(ctx)).finally(() => {
                const left = this.activeTools.get(tool.label) - 1;
                if (left > 0) this.activeTools.set(tool.label, left);
                else this.activeTools.delete(tool.label);
            });
        };

        // A tool that may only run once at a time waits for its turn before it
        // takes a worker slot, so the waiting does not hold one up
        const gate = gateFor(tool);
        if (gate && !(await gate.acquire(signal))) {
            this.toolsDone += 1;
            this.emit('change', this);
            return null;
        }

        let result = null;
        try {
            // One slot per running optimizer, shared with every other file. A
            // file stopped while waiting gives up its place in line.
            result = this.semaphore ? await this.semaphore.run(execute, signal) : await execute();
        } catch (err) {
            console.warn(`${tool.id} failed:`, err.message);
            this.noteProblem(tool, 'failed');
        } finally {
            if (gate) gate.release();
        }

        // Nothing written is nothing gained, not damage: svgcleaner, for one,
        // exits 0 with empty output when its result would be bigger
        if (result && !result.size) result = null;

        if (timeout && timeout.aborted && !signal.aborted) {
            console.warn(`${tool.id} timed out`);
            this.noteProblem(tool, 'timed out');
            result = null;
        } else if (result && !signal.aborted && !looksComplete(this.type, temp)) {
            // Exited 0 with a smaller file that is not a whole image
            console.warn(`${tool.id} produced an incomplete file`);
            this.noteProblem(tool, 'produced a damaged file');
            result = null;
        }

        this.toolsDone += 1;
        this.emit('change', this);

        if (!result || signal.aborted) {
            unlinkQuietly(temp);
            return null;
        }
        return { temp, ...result };
    }

    // An optimizer that crashed, hung or wrote a broken file. The file is
    // still finished with the others, so this is shown, not fatal.
    noteProblem(tool, problem) {
        this.problems.push({ tool: tool.label, problem });
    }

    async run(settings, signal) {
        // Two concurrent runs would share bestPath and bestSize and race in
        // save(). The queue also guards this, but a Job is the thing being
        // corrupted, so it refuses here too.
        if (this.isRunning) return;
        this.isRunning = true;
        try {
            await this.doRun(settings, signal);
        } finally {
            this.isRunning = false;
        }
    }

    async doRun(settings, signal) {
        this.shownProgress = 0;
        this.problems = [];
        this.startedAt = Date.now();
        this.toolsTotal = 0;
        this.toolsDone = 0;
        this.setState('running');

        let header;
        let currentSize;
        let stat;
        try {
            stat = fs.statSync(this.filePath);
            const fd = fs.openSync(this.filePath, 'r');
            try {
                header = Buffer.alloc(Math.min(HEADER_BYTES, stat.size));
                fs.readSync(fd, header, 0, header.length, 0);
            } finally {
                fs.closeSync(fd); // a failed read must not keep the file open
            }
            currentSize = stat.size;
            this.mode = stat.mode;
            this.mtime = stat.mtime;
            this.atime = stat.atime;
            // What the optimizers are about to read. Checked again before the
            // result is written back.
            this.startSize = stat.size;
            this.startMtimeMs = stat.mtimeMs;
        } catch (err) {
            this.setState('error', `Can’t open the file. ${describeFsError(err)}`);
            return;
        }

        if (!currentSize) {
            this.setState('error', 'The file is empty');
            return;
        }

        // Optimizing the same file again must keep measuring against the size it
        // had when it was first added, so that savings accumulate instead of
        // resetting. Only a file that changed on disk behind our back - someone
        // re-exported it - starts over, and then the old backup no longer belongs
        // to it. Ports the initialInput/hasChangedSinceLastSave handling in
        // doEnqueueWorkersInCPUQueue.
        const changedExternally = Boolean(this.lastSavedSize)
            && (this.lastSavedSize !== currentSize
                || (this.lastSavedMtimeMs && this.lastSavedMtimeMs !== stat.mtimeMs));
        if (!this.runCount || changedExternally) {
            this.originalSize = currentSize;
            this.steps = [];
            if (changedExternally) {
                // What is on disk now is the file's new original
                this.dropBackup();
                this.originalLost = false;
            }
        }
        this.bestSize = currentSize;

        this.type = detectType(header, this.filePath);
        if (!this.type) {
            this.setState('error', 'File is not a PNG, JPEG, GIF, SVG, WebP or AVIF image');
            return;
        }
        this.note = null;
        this.features = inspect(this.type, this.filePath, header);
        if (this.type === WEBP && !this.features) {
            this.setState('error', 'Damaged WebP file');
            return;
        }

        // Can it be written at all? Asked before any work is done. On Windows
        // fs.access only sees the read-only flag, not permissions or another
        // program holding the file, so the file is opened for writing - and
        // closed again at once, untouched.
        try {
            fs.closeSync(fs.openSync(this.filePath, 'r+'));
        } catch (err) {
            // Windows reports the Read-only attribute as no write permission
            const readOnly = !(this.mode & 0o222);
            this.setState('error', readOnly
                ? 'Read-only. Clear Read-only in the file’s Properties to optimize it.'
                : `Can’t be changed. ${describeFsError(err)}`);
            return;
        }

        // Each optimizer writes a candidate of up to this size, and a full
        // temp drive makes them all fail as though nothing could be gained
        if (!hasRoomFor(tempDir(), currentSize * 4)) {
            this.setState('error', 'Not enough free disk space for the temporary files');
            return;
        }

        // Optimized before - by an earlier run, in this session or another -
        // at least as thoroughly as these settings would: leave it alone.
        const force = this.force;
        this.force = false;
        this.inputHash = null;
        if (this.history) {
            try {
                this.inputHash = await hashFile(this.filePath, signal);
            } catch (err) {
                if (signal.aborted) {
                    this.setState('stopped');
                    return;
                }
            }
            if (!force && settings.SkipOptimized
                && satisfies(this.history.findByHash(this.inputHash), profileFor(this.type, settings))) {
                this.markSkipped();
                return;
            }
        }

        const { runFirst, runLater, level, note } = this.planTools(settings, {
            underUtilized: Boolean(this.underUtilized && this.underUtilized()),
        });
        this.toolsTotal = runFirst.length + runLater.length;
        this.toolsDone = 0;
        // What the queue learns this file's duration under, now that the
        // header has been read
        this.costClassName = this.costClass(settings);
        this.costBytes = currentSize;

        if (!this.toolsTotal && note) {
            // Nothing that can be done to this file with these settings, which
            // is not an error. Not remembered as optimized either: with lossy
            // minification turned on later it would have something to do.
            this.note = note;
            this.runCount += 1;
            this.setState('done');
            return;
        }
        if (!this.toolsTotal) {
            this.setState('error', 'Every optimizer for this format is turned off in Settings');
            return;
        }

        // Counting planned tools is not enough: with an empty bin directory every
        // file used to report done at 0% with no error anywhere.
        const installed = [...runFirst, ...runLater].filter((step) => this.resolveTool(step.tool));
        if (!installed.length) {
            this.setState('error', 'No optimizer for this format is installed');
            return;
        }

        this.emit('change', this);

        // Destructive passes, strictly in order: each one sees the previous result
        for (const step of runFirst) {
            if (signal.aborted) break;
            const result = await this.runTool(step, settings, signal);
            if (result) this.adopt(result.temp, result.size, result.label, result.lossy);
        }

        // Lossless passes all start from the same input and compete for smallest
        if (!signal.aborted && runLater.length) {
            const results = await Promise.all(runLater.map((step) => this.runTool(step, settings, signal)));

            // Smallest first, so adopt() keeps the best and discards the rest
            results
                .filter(Boolean)
                .sort((a, b) => a.size - b.size)
                .forEach((result) => this.adopt(result.temp, result.size, result.label, result.lossy));
        }

        if (signal.aborted) {
            unlinkQuietly(this.bestPath);
            this.bestPath = null;
            this.setState('stopped');
            return;
        }

        this.runCount += 1;

        if (!this.bestPath) {
            // Nothing beat what is already on disk, which is therefore as
            // optimized as these settings make it - unless it changed meanwhile.
            if (this.unchangedSinceStart()) await this.remember(settings, level, { hash: this.inputHash });
            this.setState('done');
            return;
        }

        try {
            this.save(settings);
        } catch (err) {
            this.setState('error', `Not saved. ${err.plain || describeFsError(err)}`);
            return;
        }
        await this.remember(settings, level, { written: true });
        this.setState('done');
    }

    unchangedSinceStart() {
        try {
            this.assertUnchangedSinceStart();
            return true;
        } catch (err) {
            return false;
        }
    }

    // Writes `source` over `this.filePath` without ever leaving it half-written.
    // The replacement is staged beside the target - same directory, so the same
    // volume - and renamed on top, which is atomic on NTFS. A crash therefore
    // leaves either the old file or the new one, never a truncated image.
    //
    // A rename refused because another program has the file open for a moment
    // is retried before anything less safe is attempted.
    replaceOriginal(source, settings) {
        const dir = path.dirname(this.filePath);
        const staging = path.join(dir, `.imageoptim-${process.pid.toString(16)}-${(tempCounter += 1).toString(16)}.tmp`);

        try {
            fs.copyFileSync(source, staging);
            // Apply metadata to the staged copy, so the file is complete in every
            // respect at the instant it becomes the original.
            this.applyMetadata(staging, settings);
            renameWithRetry(staging, this.filePath);
            // The backup's data is no longer the file's
            this.backupIsLink = false;
            return;
        } catch (err) {
            unlinkQuietly(staging);
            // Some network and FUSE volumes refuse a rename over an open file,
            // and a folder can refuse new files while the file itself is
            // writable. A direct copy is not atomic, so it is only tried with a
            // backup of the original in hand, and never when the disk is full.
            if (!this.backupPath || err.code === 'ENOSPC') throw err;
        }

        if (source === this.backupPath) {
            // Revert: the source is the backup itself, which this cannot harm
            fs.copyFileSync(source, this.filePath);
        } else {
            // Writing into the original would write into a hard-linked backup
            // too, so the backup gets data of its own first. If even that
            // fails, nothing has been written.
            this.detachBackup();
            try {
                fs.copyFileSync(source, this.filePath);
            } catch (err) {
                throw this.recoverOriginal(err);
            }
        }
        this.applyMetadata(this.filePath, settings);
    }

    detachBackup() {
        if (!this.backupIsLink || !this.backupPath) return;
        const own = tempPath('backup');
        fs.copyFileSync(this.backupPath, own);
        unlinkQuietly(this.backupPath);
        this.backupPath = own;
        this.backupIsLink = false;
    }

    applyMetadata(target, settings) {
        if (settings.PreservePermissions) {
            try { fs.chmodSync(target, this.mode); } catch (err) { /* best effort */ }
        }
        if (settings.PreserveDates) {
            try { fs.utimesSync(target, this.atime, this.mtime); } catch (err) { /* best effort */ }
        }
    }

    // A direct copy over the original failed, possibly halfway. Puts the
    // original back from its backup, or failing that makes sure the backup
    // outlives the session: the session's temp copy is deleted on Clear and on
    // quit. Returns the error to report, saying where the original is.
    recoverOriginal(err) {
        const plain = (text) => Object.assign(new Error(text), { plain: text });
        const why = describeFsError(err);
        if (sameContent(this.filePath, this.backupPath)) {
            return plain(why); // never touched
        }
        try {
            fs.copyFileSync(this.backupPath, this.filePath);
            if (sameContent(this.filePath, this.backupPath)) {
                return plain(`${why} The original was put back.`);
            }
        } catch (e) {
            /* rescued below */
        }

        if (this.backupIsKept) {
            return plain(`${why} The original is in the “ImageOptim originals” folder beside it.`);
        }
        for (const dir of [path.dirname(this.filePath), os.homedir()]) {
            try {
                const target = rescueName(dir, this.filePath);
                if (!target) continue;
                fs.copyFileSync(this.backupPath, target, fs.constants.COPYFILE_EXCL);
                return plain(`${why} The original was saved as ${target}`);
            } catch (e) {
                /* try the next place */
            }
        }
        this.backupPinned = true; // dropBackup() leaves it alone
        return plain(`${why} The original is at ${this.backupPath} until ImageOptim quits.`);
    }

    // Refuses to write if the file changed while the optimizers were running.
    // Otherwise the result - derived from the bytes read at the start - would
    // silently destroy whatever another program wrote in the meantime, and the
    // backup would be of the pre-edit content too, so Revert could not undo it.
    assertUnchangedSinceStart() {
        let now;
        try {
            now = fs.statSync(this.filePath);
        } catch (err) {
            throw new Error('the file is no longer there');
        }
        if (now.size !== this.startSize || now.mtimeMs !== this.startMtimeMs) {
            throw new Error('the file changed on disk while it was being optimized');
        }
        return now;
    }

    // Replaces the original with the best result, keeping a backup so the result
    // can be reverted from the UI.
    save(settings) {
        const stat = this.assertUnchangedSinceStart();
        // The result is staged beside the original before it replaces it
        if (!hasRoomFor(path.dirname(this.filePath), this.bestSize)) {
            throw new Error('there is not enough free disk space beside it');
        }

        if (!this.backupPath) {
            // A file this app wrote itself has no original of its own to keep:
            // that was kept, or not, when it was first optimized. Only content
            // it saved counts: a file merely remembered as already optimal is
            // still the user's untouched original, and treating it as ours let
            // a later lossy run overwrite it with no copy kept.
            const ownOutput = Boolean(this.history && this.history.isOwnOutput(this.inputHash));
            if (settings.KeepOriginals && !ownOutput) {
                // Throws if the copy can't be made, before anything is written
                const kept = keepOriginal(this.filePath, { atime: this.atime, mtime: this.mtime });
                const stat = fs.statSync(kept.path);
                this.backupPath = kept.path;
                this.backupIsKept = true;
                this.keptCreated = kept.created;
                this.keptSize = stat.size;
                this.keptMtimeMs = stat.mtimeMs;
            } else {
                // Made even past the budget: the save itself is safer with a
                // backup in hand, and it is let go straight after
                this.backupPath = tempPath('backup');
                this.backupIsLink = linkOrCopy(this.filePath, this.backupPath, stat);
                this.backupBytes = stat.size;
                BACKUPS.used += this.backupBytes;
            }
        }

        this.replaceOriginal(this.bestPath, settings);

        unlinkQuietly(this.bestPath);
        this.bestPath = null;

        // Over the budget, or the original's own backup was already let go -
        // a backup made now would hold an earlier result, not the original,
        // and Revert would put that back as though it were
        if (this.backupPath && !this.backupIsKept
            && (this.originalLost || BACKUPS.used > BACKUPS.budget)) {
            this.dropBackup();
            this.originalLost = true;
        }

        // Read back what is actually on disk rather than trusting the temp file's
        // measurements, since this is what the next run compares against.
        try {
            const saved = fs.statSync(this.filePath);
            this.lastSavedSize = saved.size;
            this.lastSavedMtimeMs = saved.mtimeMs;
        } catch (err) {
            this.lastSavedSize = this.bestSize;
            this.lastSavedMtimeMs = 0;
        }
    }

    revert(settings = {}) {
        if (!this.backupPath || !fs.existsSync(this.backupPath)) {
            return { ok: false, reason: 'there is no backup of this file' };
        }

        // Reverting over a file someone edited after we saved would destroy their
        // change, and the backup predates it, so there would be no way back.
        try {
            const now = fs.statSync(this.filePath);
            if (this.lastSavedSize && (now.size !== this.lastSavedSize
                || (this.lastSavedMtimeMs && now.mtimeMs !== this.lastSavedMtimeMs))) {
                return { ok: false, reason: 'the file was changed by something else after it was optimized' };
            }
        } catch (err) {
            return { ok: false, reason: 'the file is no longer there' };
        }

        if (this.backupIsKept) {
            // Only the copy as it was kept can go back: anything else there is
            // the user's, and putting it over the file could lose both.
            try {
                const kept = fs.statSync(this.backupPath);
                if (kept.size !== this.keptSize || kept.mtimeMs !== this.keptMtimeMs) {
                    return { ok: false, reason: 'its copy in the ImageOptim originals folder has been changed' };
                }
            } catch (err) {
                return { ok: false, reason: 'its copy in the ImageOptim originals folder is gone' };
            }

            try {
                if (this.keptCreated) {
                    // Moved back whole, so the file gets its exact bytes and
                    // dates again, and the folder doesn't keep a copy nobody
                    // needs.
                    try {
                        renameWithRetry(this.backupPath, this.filePath);
                    } catch (err) {
                        this.replaceOriginal(this.backupPath, settings);
                        unlinkQuietly(this.backupPath);
                    }
                    removeIfEmpty(path.dirname(this.backupPath));
                } else {
                    // The copy was there before this run, so it stays
                    this.replaceOriginal(this.backupPath, settings);
                }
            } catch (err) {
                return { ok: false, reason: `it could not be written (${err.message})` };
            }
        } else {
            try {
                this.replaceOriginal(this.backupPath, settings);
            } catch (err) {
                return { ok: false, reason: `it could not be written (${err.message})` };
            }
            unlinkQuietly(this.backupPath);
            this.releaseBackup();
        }
        this.backupPath = null;
        this.backupIsKept = false;
        this.backupIsLink = false;
        this.originalLost = false;
        this.bestSize = this.originalSize;
        this.lastSavedSize = 0;
        this.lastSavedMtimeMs = 0;
        this.runCount = 0;
        this.bestTool = null;
        this.steps = [];
        this.setState('reverted');
        return { ok: true };
    }

    // Called when the job leaves the list. The backup is a full copy of the
    // original, so leaving it behind means one orphan per optimized file.
    cleanup() {
        unlinkQuietly(this.bestPath);
        this.bestPath = null;
        this.dropBackup();
    }

    // Forgets the backup, deleting it only if it is the session's temp copy.
    // A kept original is never deleted.
    dropBackup() {
        if (!this.backupIsKept && !this.backupPinned) unlinkQuietly(this.backupPath);
        this.releaseBackup();
        this.backupPath = null;
        this.backupIsKept = false;
        this.backupIsLink = false;
    }

    // Gives the backup's size back to the budget
    releaseBackup() {
        BACKUPS.used = Math.max(0, BACKUPS.used - (this.backupBytes || 0));
        this.backupBytes = 0;
    }
}

module.exports = { Job, isSmall, sweepTempDirs, releaseTempDir, RENAME_RETRY, BACKUPS };
