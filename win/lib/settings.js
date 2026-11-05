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

    // WebP and AVIF, which the macOS app does not handle. cwebp recompresses
    // a lossless WebP losslessly, and with lossy minification on re-encodes a
    // lossy one at WebPQuality; webpmux strips its EXIF and XMP. AVIF has no
    // lossless optimizer, so avifenc only re-encodes, at AvifQuality, and only
    // with lossy minification on. The qualities come from a test over 13 lossy
    // WebP and 22 AVIF files of the kind found on the web: WebP at 75 saved
    // 26% (PSNR against the input 36-45 dB), AVIF at 60 saved 13% (41-50 dB),
    // and AVIF at 50 was visibly worse on photos.
    CwebpEnabled: true,
    WebpmuxEnabled: true,
    AvifencEnabled: true,
    WebPQuality: 75,
    AvifQuality: 60,
    // EXIF and XMP, from both formats. The ICC profile always stays: without
    // it the colours would change.
    WebPAvifStripMetadata: true,

    // Which file to start on. Smallest first means the list fills with finished
    // rows quickly instead of appearing stuck on one big image; largest first
    // finishes sooner overall, because the slowest file is not left running on
    // its own at the end. 'added' keeps drop order.
    QueueOrder: 'smallest', // 'smallest' | 'largest' | 'added'

    PreservePermissions: true,
    PreserveDates: false,

    // Leave files alone that an earlier run already optimized at least as
    // thoroughly as the current settings would (lib/history.js). Optimize
    // Again always runs.
    SkipOptimized: true,

    // Before the first save, copy the untouched file into an "ImageOptim
    // originals" folder beside it (lib/originals.js). Off by default: in place
    // is what the app has always done, and the folder would otherwise turn up
    // in web roots and repositories.
    KeepOriginals: false,

    // How many optimizer processes may run at once, across every file. The
    // macOS app sizes its single worker queue by processor count; a fixed 4
    // left most of a modern machine idle while Zopfli - which is far and away
    // the slowest step - ran one file at a time.
    // Measured on a 16-core machine over 30 photos: 2 workers 27.0s, 4 workers
    // 15.0s, 8 workers 12.0s, 16 workers 12.6s. Past eight the optimizers just
    // contend, so take the core count but stop at eight. Only saved when the
    // user picks a number, so a settings file copied to another PC does not
    // carry this one's core count with it.
    MaxWorkers: defaultWorkers(),

    // Run Zopfli on everything, with no time budget, the way the macOS app
    // does. Much slower for a fraction of a percent; off by default.
    ThoroughPng: false,

    // The accent colour, as an OKLCH hue in degrees and a saturation in
    // percent of the strongest chroma offered. The renderer derives every
    // shade from these at fixed lightnesses, so text stays readable whatever
    // is picked. The default is the blue the app ships with.
    AccentHue: 253,
    AccentSaturation: 80,

    // 'system' follows Windows; 'light' and 'dark' override it for this app.
    Theme: 'system',

    // Ask before quitting or clearing the list throws away the session's
    // backups, which Revert needs. Stopping files mid-run is always asked.
    ConfirmDiscardBackups: true,
};

function defaultWorkers() {
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(2, Math.min(8, cores));
}

// What each setting may hold. Values come from settings.json, which anyone can
// edit, and from the window: a number past its range, or a string where a
// switch belongs, would otherwise go straight into an optimizer's command
// line. Anything that does not fit is clamped or, failing that, ignored.
const bool = { type: 'boolean' };
const int = (min, max) => ({ type: 'int', min, max });
const oneOf = (...values) => ({ type: 'enum', values });

const SCHEMA = {
    LossyEnabled: bool,
    JpegOptimMaxQuality: int(10, 100),
    PngMinQuality: int(0, 100),
    GifQuality: int(0, 100),
    AdvPngEnabled: bool,
    AdvPngLevel: int(1, 7),
    JpegOptimEnabled: bool,
    JpegTranEnabled: bool,
    JpegTranStripAll: bool,
    GuetzliEnabled: bool,
    OptiPngEnabled: bool,
    PngCrush2Enabled: bool,
    PngOutRemoveChunks: bool,
    ZopfliEnabled: bool,
    ZopfliSkipAboveKB: int(0, 1024 * 1024),
    ZopfliMaxSeconds: int(0, 3600),
    GifsicleEnabled: bool,
    SvgoEnabled: bool,
    SvgcleanerEnabled: bool,
    CwebpEnabled: bool,
    WebpmuxEnabled: bool,
    AvifencEnabled: bool,
    WebPQuality: int(0, 100),
    AvifQuality: int(0, 100),
    WebPAvifStripMetadata: bool,
    QueueOrder: oneOf('smallest', 'largest', 'added'),
    PreservePermissions: bool,
    PreserveDates: bool,
    SkipOptimized: bool,
    KeepOriginals: bool,
    MaxWorkers: int(1, 16),
    ThoroughPng: bool,
    AccentHue: int(0, 359),
    AccentSaturation: int(0, 100),
    Theme: oneOf('system', 'light', 'dark'),
    ConfirmDiscardBackups: bool,
};

// The value to store for `key`, or undefined when `value` cannot be one
function coerce(key, value) {
    const rule = SCHEMA[key];
    if (!rule) return undefined;
    if (rule.type === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (value === 0 || value === 1) return Boolean(value);
        return undefined;
    }
    if (rule.type === 'int') {
        if (typeof value !== 'number' && typeof value !== 'string') return undefined;
        if (typeof value === 'string' && !value.trim()) return undefined;
        const n = Number(value);
        if (!Number.isFinite(n)) return undefined;
        return Math.min(rule.max, Math.max(rule.min, Math.round(n)));
    }
    return rule.values.includes(value) ? value : undefined;
}

// settings.json format versions. 0: every value written out on the first
// change (before versions existed), so a default could never change for
// anyone who had touched a setting. 1: only what differs from the defaults.
const VERSION = 1;

function migrate(stored) {
    const values = { ...stored };
    if (!stored.version) {
        // Version 0 saved MaxWorkers' default along with everything else,
        // pinning this PC's core count as though the user had chosen it
        if (values.MaxWorkers === defaultWorkers()) delete values.MaxWorkers;
    }
    delete values.version;
    return values;
}

const SAVE_DELAY_MS = 300;

class Settings {
    // saveDelayMs: how long to wait for more changes before writing. A slider
    // sends one per step it is dragged through.
    constructor(filePath, { saveDelayMs = SAVE_DELAY_MS } = {}) {
        this.filePath = filePath;
        this.saveDelayMs = saveDelayMs;
        this.values = { ...DEFAULTS };
        this.timer = null;
        this.load();
    }

    load() {
        let stored;
        try {
            stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.warn('Could not read settings:', err.message);
            }
            return;
        }
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
        const values = migrate(stored);
        for (const key of Object.keys(DEFAULTS)) {
            if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
            const value = coerce(key, values[key]);
            if (value !== undefined) this.values[key] = value;
        }
    }

    // Written beside the file and renamed over it, so a crash or a full disk
    // leaves the old settings or the new ones, never an empty file that
    // silently resets everything.
    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        const changed = { version: VERSION };
        for (const [key, value] of Object.entries(this.values)) {
            if (value !== DEFAULTS[key]) changed[key] = value;
        }
        const staging = `${this.filePath}.tmp`;
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(staging, `${JSON.stringify(changed, null, 2)}\n`);
            fs.renameSync(staging, this.filePath);
        } catch (err) {
            console.warn('Could not write settings:', err.message);
            try { fs.unlinkSync(staging); } catch (e) { /* not there */ }
        }
    }

    save() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), this.saveDelayMs);
        // Never the reason the app stays open; flush() runs on quit anyway
        if (this.timer.unref) this.timer.unref();
    }

    get(key) {
        return this.values[key];
    }

    all() {
        return { ...this.values };
    }

    // Applies what fits and ignores the rest. Takes effect at once; the file
    // follows shortly after.
    update(patch) {
        if (patch && typeof patch === 'object') {
            for (const [key, raw] of Object.entries(patch)) {
                if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
                const value = coerce(key, raw);
                if (value !== undefined) this.values[key] = value;
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

module.exports = { Settings, DEFAULTS, SCHEMA, coerce };
