'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Defaults carried over from imageoptim/defaults.plist. The macOS-only keys
// (BounceDock, RunLowPriority, dir-scan concurrency) are dropped; GuetzliEnabled
// is off by default because Guetzli needs minutes and gigabytes per image.
//
// PngOutEnabled has no Windows equivalent: PNGOUT is a closed-source binary that
// ImageOptim downloads separately on macOS, so it is not part of this build.
const DEFAULTS = {
    LossyEnabled: false,
    JpegOptimMaxQuality: 80,
    PngMinQuality: 80,
    GifQuality: 80,

    AdvPngEnabled: true,
    AdvPngLevel: 4, // "effort" level, reused by every tool as in the macOS app
    JpegOptimEnabled: true,
    JpegTranEnabled: true,
    JpegTranStripAll: true,
    GuetzliEnabled: false,
    OptiPngEnabled: true, // oxipng
    PngCrush2Enabled: false,
    PngOutRemoveChunks: true,
    ZopfliEnabled: true,

    // Above this size, measured on the file as it stands, Zopfli is skipped.
    // Measured on photographic PNGs from 177 KB to 2 MB, oxipng produced a
    // SMALLER file than Zopfli every time, 20 to 60 times faster - on a 2 MB
    // PNG, 1,354,628 bytes in 3.2s against Zopfli's 1,389,170 in 55.7s. Zopfli
    // still earns its place on small flat graphics, so it keeps those. 0 runs
    // it on everything, which is what the macOS app does.
    ZopfliSkipAboveKB: 256,

    // Seconds Zopfli may spend on one image. ImageOptim's own formula allows up
    // to 8 + level * 13 seconds, which on a multi-megabyte PNG means nearly a
    // minute per file - and measured against photographic PNGs that minute buys
    // about 0.01% extra. 0 means no cap, i.e. the original behaviour.
    ZopfliMaxSeconds: 5,
    GifsicleEnabled: true,
    SvgoEnabled: true,
    SvgcleanerEnabled: true,

    // Which file to start on. Smallest first means the list fills with finished
    // rows quickly instead of appearing stuck on one big image; largest first
    // finishes sooner overall, because the slowest file is not left running on
    // its own at the end. 'added' keeps drop order.
    QueueOrder: 'smallest', // 'smallest' | 'largest' | 'added'

    PreservePermissions: true,
    PreserveDates: false,

    // How many optimizer processes may run at once, across every file. The
    // macOS app sizes its single worker queue by processor count; a fixed 4
    // left most of a modern machine idle while Zopfli - which is far and away
    // the slowest step - ran one file at a time.
    // Measured on a 16-core machine over 30 photos: 2 workers 27.0s, 4 workers
    // 15.0s, 8 workers 12.0s, 16 workers 12.6s. Past eight the optimizers just
    // contend, so take the core count but stop at eight.
    MaxWorkers: Math.max(2, Math.min(8, os.cpus().length)),

    // Run Zopfli on everything, with no time budget, the way the macOS app
    // does. Much slower for a fraction of a percent; off by default.
    ThoroughPng: false,
};

class Settings {
    constructor(filePath) {
        this.filePath = filePath;
        this.values = { ...DEFAULTS };
        this.load();
    }

    load() {
        try {
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const stored = JSON.parse(raw);
            for (const key of Object.keys(DEFAULTS)) {
                if (Object.prototype.hasOwnProperty.call(stored, key)) {
                    this.values[key] = stored[key];
                }
            }
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('Could not read settings:', err.message);
            }
        }
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.values, null, 2));
        } catch (err) {
            console.warn('Could not write settings:', err.message);
        }
    }

    get(key) {
        return this.values[key];
    }

    all() {
        return { ...this.values };
    }

    update(patch) {
        for (const [key, value] of Object.entries(patch)) {
            if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
                this.values[key] = value;
            }
        }
        this.save();
        return this.all();
    }

    reset() {
        this.values = { ...DEFAULTS };
        this.save();
        return this.all();
    }
}

module.exports = { Settings, DEFAULTS };
