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
    GifsicleEnabled: true,
    SvgoEnabled: true,
    SvgcleanerEnabled: true,

    PreservePermissions: true,
    PreserveDates: false,

    // How many optimizer processes may run at once, across every file. The
    // macOS app sizes its single worker queue by processor count; a fixed 4
    // left most of a modern machine idle while Zopfli - which is far and away
    // the slowest step - ran one file at a time.
    MaxWorkers: Math.max(1, os.cpus().length),
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
