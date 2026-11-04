'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tools = require('./tools');
const { detectType, isSmall, PNG, JPEG, GIF, SVG } = require('./filetype');

let tempCounter = 0;
let tempRoot = null;

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

// Removes our own scratch directory, plus any left behind by a previous run that
// was killed. Called at startup and again on quit.
function sweepTempDirs() {
    let entries = [];
    try {
        entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true });
    } catch (err) {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('ImageOptim-')) continue;
        const dir = path.join(os.tmpdir(), entry.name);
        if (dir === tempRoot) continue; // ours, still in use
        try {
            fs.rmSync(dir, { recursive: true, force: true });
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

// A single image being optimized. Ports Job.m: pick the applicable optimizers,
// run the destructive ones first and one at a time, then race the lossless ones,
// and keep whichever output turned out smallest.
class Job extends EventEmitter {
    constructor(filePath, options) {
        super();
        this.filePath = filePath;
        this.name = path.basename(filePath);
        this.resolveTool = options.resolveTool;
        this.semaphore = options.semaphore;

        this.type = null;
        this.originalSize = 0;
        this.bestSize = 0;
        this.bestPath = null;      // temp file holding the best result so far
        this.bestTool = null;
        this.backupPath = null;    // pre-optimization copy, for Revert
        this.lastSavedSize = 0;    // size we last wrote, to spot outside edits
        this.lastSavedMtimeMs = 0; // and when, to spot a same-size edit
        this.isRunning = false;
        this.runCount = 0;
        this.state = 'queued';
        this.error = null;
        this.toolsTotal = 0;
        this.toolsDone = 0;
    }

    get percentOptimized() {
        if (!this.originalSize || !this.bestSize) return 0;
        if (this.bestSize >= this.originalSize) return 0;
        return (1 - this.bestSize / this.originalSize) * 100;
    }

    get isOptimized() {
        return Boolean(this.bestSize) && this.bestSize < this.originalSize;
    }

    get canRevert() {
        return Boolean(this.backupPath) && fs.existsSync(this.backupPath);
    }

    toJSON() {
        return {
            id: this.filePath,
            name: this.name,
            path: this.filePath,
            type: this.type,
            originalSize: this.originalSize,
            bestSize: this.bestSize || this.originalSize,
            percentOptimized: this.percentOptimized,
            bestTool: this.bestTool,
            state: this.state,
            error: this.error,
            progress: this.toolsTotal ? this.toolsDone / this.toolsTotal : 0,
            canRevert: this.canRevert,
        };
    }

    setState(state, error) {
        this.state = state;
        this.error = error || null;
        this.emit('change', this.toJSON());
    }

    // Keeps the candidate only when it is genuinely smaller, exactly as
    // setFileOptimized:toolName: does.
    adopt(candidatePath, size, label) {
        if (!size || size >= this.bestSize) {
            unlinkQuietly(candidatePath);
            return false;
        }

        const previous = this.bestPath;
        this.bestPath = candidatePath;
        this.bestSize = size;
        this.bestTool = label;
        unlinkQuietly(previous);
        this.emit('change', this.toJSON());
        return true;
    }

    // Which optimizers apply, and in which order. Ports the switch in
    // doEnqueueWorkersInCPUQueue.
    planTools(settings) {
        const hasBeenRunBefore = this.runCount > 0;
        const lossyEnabled = Boolean(settings.LossyEnabled);
        let level = Number(settings.AdvPngLevel) || 4;

        const plan = [];
        let lossyConverted = false;

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
            if (settings.ZopfliEnabled) {
                const skipAbove = settings.ThoroughPng ? 0 : Number(settings.ZopfliSkipAboveKB) * 1024;
                if (!skipAbove || this.bestSize <= skipAbove) {
                    plan.push({ tool: tools.byId('zopflipng'), alternativeStrategy: hasBeenRunBefore });
                }
            }
        } else if (this.type === JPEG) {
            if (!lossyConverted && !hasBeenRunBefore && tools.byId('guetzli').enabled(settings)) {
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
        }

        // Optimizers that rewrite the image rather than merely recompressing it
        // have to run first, one at a time, so later tools see their output.
        const runFirst = [];
        const runLater = [];
        for (const step of plan) {
            const destructive = step.first
                || (step.tool.makesNonOptimizingModifications
                    ? step.tool.makesNonOptimizingModifications(settings)
                    : step.tool.lossy);
            (destructive ? runFirst : runLater).push({ ...step, level });
        }

        return { runFirst, runLater, level };
    }

    async runTool(step, settings, signal) {
        const { tool } = step;
        const resolved = this.resolveTool(tool);
        if (!resolved) {
            // Not installed. Still counts as finished, or the progress fraction
            // never reaches 1 and the row looks stuck.
            this.toolsDone += 1;
            this.emit('change', this.toJSON());
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
            signal,
            exe: resolved.exe,
            script: resolved.script,
        };

        let result = null;
        try {
            // One slot per running optimizer, shared with every other file
            result = this.semaphore
                ? await this.semaphore.run(() => tool.run(ctx))
                : await tool.run(ctx);
        } catch (err) {
            console.warn(`${tool.id} failed:`, err.message);
        }

        this.toolsDone += 1;
        this.emit('change', this.toJSON());

        if (!result || signal.aborted) {
            unlinkQuietly(temp);
            return null;
        }
        return { temp, ...result };
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
        this.setState('running');

        let header;
        let currentSize;
        let stat;
        try {
            stat = fs.statSync(this.filePath);
            const fd = fs.openSync(this.filePath, 'r');
            header = Buffer.alloc(Math.min(16, stat.size));
            fs.readSync(fd, header, 0, header.length, 0);
            fs.closeSync(fd);
            currentSize = stat.size;
            this.mode = stat.mode;
            this.mtime = stat.mtime;
            this.atime = stat.atime;
            // What the optimizers are about to read. Checked again before the
            // result is written back.
            this.startSize = stat.size;
            this.startMtimeMs = stat.mtimeMs;
        } catch (err) {
            this.setState('error', 'Can’t open the file');
            return;
        }

        if (!currentSize) {
            this.setState('error', 'Can’t open the file');
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
            if (changedExternally) {
                unlinkQuietly(this.backupPath);
                this.backupPath = null;
            }
        }
        this.bestSize = currentSize;

        this.type = detectType(header, this.filePath);
        if (!this.type) {
            this.setState('error', 'File is neither PNG, GIF, JPEG nor SVG');
            return;
        }

        try {
            fs.accessSync(this.filePath, fs.constants.W_OK);
        } catch (err) {
            this.setState('error', 'Optimized file could not be saved');
            return;
        }

        const { runFirst, runLater } = this.planTools(settings);
        this.toolsTotal = runFirst.length + runLater.length;
        this.toolsDone = 0;

        if (!this.toolsTotal) {
            this.setState('error', 'All necessary tools have been disabled in Preferences');
            return;
        }

        // Counting planned tools is not enough: with an empty bin directory every
        // file used to report done at 0% with no error anywhere.
        const installed = [...runFirst, ...runLater].filter((step) => this.resolveTool(step.tool));
        if (!installed.length) {
            this.setState('error', 'No optimizer for this format is installed');
            return;
        }

        this.emit('change', this.toJSON());

        // Destructive passes, strictly in order: each one sees the previous result
        for (const step of runFirst) {
            if (signal.aborted) break;
            const result = await this.runTool(step, settings, signal);
            if (result) this.adopt(result.temp, result.size, result.label);
        }

        // Lossless passes all start from the same input and compete for smallest
        if (!signal.aborted && runLater.length) {
            const serial = runLater.filter((s) => s.tool.serial);
            const parallel = runLater.filter((s) => !s.tool.serial);

            const results = await Promise.all(parallel.map((step) => this.runTool(step, settings, signal)));
            for (const step of serial) {
                if (signal.aborted) break;
                results.push(await this.runTool(step, settings, signal));
            }

            // Smallest first, so adopt() keeps the best and discards the rest
            results
                .filter(Boolean)
                .sort((a, b) => a.size - b.size)
                .forEach((result) => this.adopt(result.temp, result.size, result.label));
        }

        if (signal.aborted) {
            unlinkQuietly(this.bestPath);
            this.bestPath = null;
            this.setState('stopped');
            return;
        }

        this.runCount += 1;

        if (!this.bestPath) {
            this.setState('done'); // nothing beat what is already on disk
            return;
        }

        try {
            this.save(settings);
            this.setState('done');
        } catch (err) {
            this.setState('error', `Optimized file could not be saved: ${err.message}`);
        }
    }

    // Writes `source` over `this.filePath` without ever leaving it half-written.
    // The replacement is staged beside the target - same directory, so the same
    // volume - and renamed on top, which is atomic on NTFS. A crash therefore
    // leaves either the old file or the new one, never a truncated image.
    replaceOriginal(source, settings) {
        const dir = path.dirname(this.filePath);
        const staging = path.join(dir, `.imageoptim-${process.pid.toString(16)}-${(tempCounter += 1).toString(16)}.tmp`);

        try {
            fs.copyFileSync(source, staging);
            // Apply metadata to the staged copy, so the file is complete in every
            // respect at the instant it becomes the original.
            if (settings.PreservePermissions) {
                try { fs.chmodSync(staging, this.mode); } catch (err) { /* best effort */ }
            }
            if (settings.PreserveDates) {
                try { fs.utimesSync(staging, this.atime, this.mtime); } catch (err) { /* best effort */ }
            }
            fs.renameSync(staging, this.filePath);
            return;
        } catch (err) {
            unlinkQuietly(staging);
            // Some network and FUSE volumes refuse a rename over an open file.
            // Fall back to a direct copy, which is not atomic - acceptable only
            // because a backup of the original already exists by this point.
            if (!this.backupPath) throw err;
            fs.copyFileSync(source, this.filePath);
            if (settings.PreservePermissions) {
                try { fs.chmodSync(this.filePath, this.mode); } catch (e) { /* best effort */ }
            }
            if (settings.PreserveDates) {
                try { fs.utimesSync(this.filePath, this.atime, this.mtime); } catch (e) { /* best effort */ }
            }
        }
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
    }

    // Replaces the original with the best result, keeping a backup so the result
    // can be reverted from the UI.
    save(settings) {
        this.assertUnchangedSinceStart();

        if (!this.backupPath) {
            this.backupPath = tempPath('backup');
            fs.copyFileSync(this.filePath, this.backupPath);
        }

        this.replaceOriginal(this.bestPath, settings);

        unlinkQuietly(this.bestPath);
        this.bestPath = null;

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
        if (!this.canRevert) return { ok: false, reason: 'there is no backup of this file' };

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

        this.replaceOriginal(this.backupPath, settings);
        unlinkQuietly(this.backupPath);
        this.backupPath = null;
        this.bestSize = this.originalSize;
        this.lastSavedSize = 0;
        this.lastSavedMtimeMs = 0;
        this.runCount = 0;
        this.bestTool = null;
        this.setState('reverted');
        return { ok: true };
    }

    // Called when the job leaves the list. The backup is a full copy of the
    // original, so leaving it behind means one orphan per optimized file.
    cleanup() {
        unlinkQuietly(this.bestPath);
        this.bestPath = null;
        unlinkQuietly(this.backupPath);
        this.backupPath = null;
    }
}

module.exports = { Job, isSmall, sweepTempDirs, releaseTempDir };
