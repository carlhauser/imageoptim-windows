'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tools = require('./tools');
const { detectType, isSmall, PNG, JPEG, GIF, SVG } = require('./filetype');

let tempCounter = 0;

function tempPath(toolId) {
    tempCounter += 1;
    const unique = `${process.pid.toString(16)}.${tempCounter.toString(16)}`;
    return path.join(os.tmpdir(), `ImageOptim.${toolId}.${unique}.temp`);
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
                plan.push({ tool: tools.byId('zopflipng'), alternativeStrategy: hasBeenRunBefore });
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
            return null; // optimizer not installed; the macOS app skips it too
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
        this.setState('running');

        let header;
        let currentSize;
        try {
            const stat = fs.statSync(this.filePath);
            const fd = fs.openSync(this.filePath, 'r');
            header = Buffer.alloc(Math.min(16, stat.size));
            fs.readSync(fd, header, 0, header.length, 0);
            fs.closeSync(fd);
            currentSize = stat.size;
            this.mode = stat.mode;
            this.mtime = stat.mtime;
            this.atime = stat.atime;
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
        const changedExternally = Boolean(this.lastSavedSize) && this.lastSavedSize !== currentSize;
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

    // Replaces the original with the best result, keeping a backup so the result
    // can be reverted from the UI.
    save(settings) {
        if (!this.backupPath) {
            this.backupPath = tempPath('backup');
            fs.copyFileSync(this.filePath, this.backupPath);
        }

        fs.copyFileSync(this.bestPath, this.filePath);

        if (settings.PreservePermissions) {
            // On Windows the meaningful permissions live in the ACL, which
            // copyFileSync leaves on the existing file; this keeps the Unix mode
            // bits in step as well, which matters on a network share.
            try { fs.chmodSync(this.filePath, this.mode); } catch (err) { /* best effort */ }
        }
        if (settings.PreserveDates) {
            try { fs.utimesSync(this.filePath, this.atime, this.mtime); } catch (err) { /* best effort */ }
        }

        unlinkQuietly(this.bestPath);
        this.bestPath = null;
        this.lastSavedSize = this.bestSize;
    }

    revert() {
        if (!this.canRevert) return false;
        fs.copyFileSync(this.backupPath, this.filePath);
        unlinkQuietly(this.backupPath);
        this.backupPath = null;
        this.bestSize = this.originalSize;
        this.lastSavedSize = 0;
        this.runCount = 0;
        this.bestTool = null;
        this.setState('reverted');
        return true;
    }

    cleanup() {
        unlinkQuietly(this.bestPath);
        this.bestPath = null;
    }
}

module.exports = { Job, isSmall };
