'use strict';

// Which optimizers a file gets, and in which group. Ported from the switch in
// imageoptim/Backend/Job.m doEnqueueWorkersInCPUQueue.

const test = require('node:test');
const assert = require('node:assert');
const { Job } = require('../lib/job');
const { DEFAULTS } = require('../lib/settings');
const { makeFile, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

function plan(type, settings = {}, { size = 4096, runCount = 0, features = null } = {}) {
    const job = new Job(makeFile(`plan-${Math.random().toString(16).slice(2)}.${type}`, type, size), {
        resolveTool: () => ({ exe: '/fake/tool' }),
    });
    job.type = type;
    job.features = features;
    job.bestSize = size;
    job.originalSize = size;
    job.runCount = runCount;
    const { runFirst, runLater, note } = job.planTools({ ...DEFAULTS, ...settings });
    return {
        first: runFirst.map((s) => s.tool.id),
        later: runLater.map((s) => s.tool.id),
        all: [...runFirst, ...runLater].map((s) => s.tool.id),
        note: note ? `${note.text}: ${note.detail}` : null,
    };
}

const LOSSLESS_WEBP = { lossless: true, lossy: false, animated: false, exif: false, xmp: false };
const LOSSY_WEBP = { ...LOSSLESS_WEBP, lossless: false, lossy: true };
const STILL_AVIF = { animated: false, gainMap: false };

test('PNG — defaults', () => {
    const p = plan('png');
    assert.deepStrictEqual(p.all.sort(), ['advpng', 'oxipng', 'zopflipng']);
    assert.ok(!p.all.includes('pngcrush'), 'PngCrush2Enabled is false by default');
    assert.deepStrictEqual(p.first, ['zopflipng'], 'Zopfli rewrites the file, so it runs first');
});

test('PNG — Zopfli is skipped above the size threshold', () => {
    assert.ok(!plan('png', {}, { size: 300 * 1024 }).all.includes('zopflipng'));
    assert.ok(plan('png', {}, { size: 200 * 1024 }).all.includes('zopflipng'));
});

test('PNG — ThoroughPng puts Zopfli back on large files', () => {
    const p = plan('png', { ThoroughPng: true }, { size: 4 * 1024 * 1024 });
    assert.ok(p.all.includes('zopflipng'));
});

test('PNG — ZopfliSkipAboveKB of 0 means never skip', () => {
    const p = plan('png', { ZopfliSkipAboveKB: 0 }, { size: 4 * 1024 * 1024 });
    assert.ok(p.all.includes('zopflipng'));
});

test('PNG — AdvPNG only when metadata may be stripped', () => {
    assert.ok(!plan('png', { PngOutRemoveChunks: false }).all.includes('advpng'));
});

test('PNG — pngcrush is dropped at low effort when oxipng is on', () => {
    // Job.m: if (level < 2 && oxipngEnabled) pngcrushEnabled = NO
    const low = plan('png', { PngCrush2Enabled: true, AdvPngLevel: 1 });
    assert.ok(!low.all.includes('pngcrush'));
    const high = plan('png', { PngCrush2Enabled: true, AdvPngLevel: 4 });
    assert.ok(high.all.includes('pngcrush'));
});

test('PNG — lossy adds pngquant, and it runs first', () => {
    const p = plan('png', { LossyEnabled: true, PngMinQuality: 80 });
    assert.ok(p.first.includes('pngquant'));
});

test('PNG — pngquant stays out at the extremes of the quality range', () => {
    assert.ok(!plan('png', { LossyEnabled: true, PngMinQuality: 100 }).all.includes('pngquant'));
    assert.ok(!plan('png', { LossyEnabled: true, PngMinQuality: 30 }).all.includes('pngquant'));
});

test('JPEG — defaults', () => {
    assert.deepStrictEqual(plan('jpeg').all.sort(), ['jpegoptim', 'jpegtran']);
});

test('JPEG — Guetzli only when enabled, and never on a repeat run', () => {
    assert.ok(plan('jpeg', { GuetzliEnabled: true }).all.includes('guetzli'));
    assert.ok(!plan('jpeg', { GuetzliEnabled: true }, { runCount: 1 }).all.includes('guetzli'),
        'hasBeenRunBefore excludes Guetzli');
    assert.ok(!plan('jpeg', { GuetzliEnabled: true, LossyEnabled: true, JpegOptimMaxQuality: 70 })
        .all.includes('guetzli'), 'quality below 80 excludes Guetzli');
});

test('GIF — defaults, and the interlaced pass above effort 1', () => {
    assert.deepStrictEqual(plan('gif').all, ['gifsicle', 'gifsicle-interlaced']);
    assert.deepStrictEqual(plan('gif', { AdvPngLevel: 1 }).all, ['gifsicle']);
});

test('GIF — lossy replaces both passes with one, run first', () => {
    const p = plan('gif', { LossyEnabled: true, GifQuality: 80 });
    assert.deepStrictEqual(p.all, ['gifsicle']);
    assert.deepStrictEqual(p.first, ['gifsicle']);
});

test('SVG — defaults', () => {
    assert.deepStrictEqual(plan('svg').all, ['svgo', 'svgcleaner']);
});

test('WebP — a lossless file is recompressed losslessly, alongside the others', () => {
    const p = plan('webp', {}, { features: LOSSLESS_WEBP });
    assert.deepStrictEqual(p.all, ['cwebp']);
    assert.deepStrictEqual(p.later, ['cwebp']);
});

test('WebP — a lossless file stays lossless with lossy minification on', () => {
    assert.deepStrictEqual(plan('webp', { LossyEnabled: true }, { features: LOSSLESS_WEBP }).all, ['cwebp']);
});

test('WebP — EXIF and XMP are stripped first, then the lossy re-encode', () => {
    const p = plan('webp', { LossyEnabled: true }, { features: { ...LOSSY_WEBP, exif: true } });
    assert.deepStrictEqual(p.first, ['webpmux', 'cwebp-lossy'],
        'stripping comes first, so the re-encode is measured on the image alone');
});

test('WebP — without lossy minification a lossy file only loses its metadata', () => {
    assert.deepStrictEqual(plan('webp', {}, { features: { ...LOSSY_WEBP, xmp: true } }).all, ['webpmux']);
    const bare = plan('webp', {}, { features: LOSSY_WEBP });
    assert.deepStrictEqual(bare.all, []);
    assert.match(bare.note, /Lossy minification off/, 'says why nothing ran');
});

test('WebP — nothing is stripped when stripping is off', () => {
    const p = plan('webp', { WebPAvifStripMetadata: false }, { features: { ...LOSSLESS_WEBP, exif: true } });
    assert.deepStrictEqual(p.all, ['cwebp']);
});

test('WebP — an animation is left alone but for its metadata', () => {
    const animated = { ...LOSSY_WEBP, animated: true };
    const p = plan('webp', { LossyEnabled: true }, { features: animated });
    assert.deepStrictEqual(p.all, []);
    assert.match(p.note, /Animated/);
    assert.deepStrictEqual(plan('webp', {}, { features: { ...animated, exif: true } }).all, ['webpmux']);
});

test('WebP — the lossy re-encode stays out at the extremes of the quality range', () => {
    for (const WebPQuality of [100, 30]) {
        assert.ok(!plan('webp', { LossyEnabled: true, WebPQuality }, { features: LOSSY_WEBP })
            .all.includes('cwebp-lossy'), `quality ${WebPQuality}`);
    }
});

test('AVIF — re-encoded only with lossy minification on', () => {
    const p = plan('avif', { LossyEnabled: true }, { features: STILL_AVIF });
    assert.deepStrictEqual(p.first, ['avifenc']);
    const off = plan('avif', {}, { features: STILL_AVIF });
    assert.deepStrictEqual(off.all, []);
    assert.match(off.note, /Lossy minification off/);
});

test('AVIF — animations and gain maps are left alone', () => {
    const anim = plan('avif', { LossyEnabled: true }, { features: { ...STILL_AVIF, animated: true } });
    assert.deepStrictEqual(anim.all, []);
    assert.match(anim.note, /Animated/);
    const gain = plan('avif', { LossyEnabled: true }, { features: { ...STILL_AVIF, gainMap: true } });
    assert.deepStrictEqual(gain.all, []);
    assert.match(gain.note, /Gain map/);
});

test('every optimizer can be switched off', () => {
    const off = {
        OptiPngEnabled: false, ZopfliEnabled: false, AdvPngEnabled: false,
        PngCrush2Enabled: false, JpegOptimEnabled: false, JpegTranEnabled: false,
        GuetzliEnabled: false, GifsicleEnabled: false, SvgoEnabled: false,
        SvgcleanerEnabled: false, CwebpEnabled: false, WebpmuxEnabled: false,
        AvifencEnabled: false,
    };
    for (const type of ['png', 'jpeg', 'gif', 'svg']) {
        assert.deepStrictEqual(plan(type, off).all, [], `${type} should plan nothing`);
    }
    // Lossy on, so that the lossy re-encodes are offered and then refused
    const offLossy = { ...off, LossyEnabled: true };
    for (const features of [LOSSLESS_WEBP, { ...LOSSY_WEBP, exif: true }]) {
        const p = plan('webp', offLossy, { features });
        assert.deepStrictEqual(p.all, [], 'webp should plan nothing');
        assert.strictEqual(p.note, null, 'switched off is not a property of the file');
    }
    assert.deepStrictEqual(plan('avif', offLossy, { features: STILL_AVIF }).all, []);
});

test('repeat runs raise the effort level', () => {
    // Job.m increments the level when the file has been optimized before
    const first = plan('png', { PngCrush2Enabled: true, AdvPngLevel: 1 });
    const second = plan('png', { PngCrush2Enabled: true, AdvPngLevel: 1 }, { runCount: 1 });
    assert.ok(!first.all.includes('pngcrush'), 'level 1 drops pngcrush');
    assert.ok(second.all.includes('pngcrush'), 'level 2 keeps it');
});

// The time-left estimate groups files by how long they take (lib/eta.js), and
// what decides that is whether Zopfli or Guetzli runs. costClass must agree
// with the plan about both.
test('costClass names the slow optimizers that planTools picks', () => {
    const cases = [
        ['png', { size: 100 * 1024 }, {}],
        ['png', { size: 300 * 1024 }, {}],
        ['png', { size: 300 * 1024 }, { ThoroughPng: true }],
        ['png', { size: 100 * 1024 }, { ZopfliEnabled: false }],
        ['jpeg', { size: 4096 }, { GuetzliEnabled: true }],
        ['jpeg', { size: 4096, runCount: 1 }, { GuetzliEnabled: true }],
        ['jpeg', { size: 4096 }, { GuetzliEnabled: true, JpegOptimMaxQuality: 70 }],
        ['webp', { size: 4096 }, {}],
        ['avif', { size: 4096 }, { LossyEnabled: true }],
    ];
    for (const [type, { size, runCount = 0 }, overrides] of cases) {
        const job = new Job(makeFile(`cls-${Math.random().toString(16).slice(2)}.${type}`, type, size), {
            resolveTool: () => ({ exe: '/fake/tool' }),
        });
        job.type = type;
        job.bestSize = size;
        job.originalSize = size;
        job.runCount = runCount;
        const settings = { ...DEFAULTS, ...overrides };
        const { runFirst, runLater } = job.planTools(settings);
        const ids = [...runFirst, ...runLater].map((s) => s.tool.id);
        const cls = job.costClass(settings).split('+');
        const label = `${type} ${size} ${JSON.stringify(overrides)} run ${runCount}`;
        assert.strictEqual(cls[0], type, label);
        assert.strictEqual(cls.includes('zopfli'), ids.includes('zopflipng'), label);
        assert.strictEqual(cls.includes('guetzli'), ids.includes('guetzli'), label);
    }
});

test('costClass guesses the type from the extension before the header is read', () => {
    const job = new Job('C:\photos\Holiday.JPEG', { resolveTool: () => null });
    job.originalSize = 1000;
    assert.strictEqual(job.costClass({ ...DEFAULTS, LossyEnabled: true }), 'jpeg+lossy');
});
