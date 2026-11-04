'use strict';

// Which optimizers a file gets, and in which group. Ported from the switch in
// imageoptim/Backend/Job.m doEnqueueWorkersInCPUQueue.

const test = require('node:test');
const assert = require('node:assert');
const { Job } = require('../lib/job');
const { DEFAULTS } = require('../lib/settings');
const { makeFile, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

function plan(type, settings = {}, { size = 4096, runCount = 0 } = {}) {
    const job = new Job(makeFile(`plan-${Math.random().toString(16).slice(2)}.${type}`, type, size), {
        resolveTool: () => ({ exe: '/fake/tool' }),
    });
    job.type = type;
    job.bestSize = size;
    job.originalSize = size;
    job.runCount = runCount;
    const { runFirst, runLater } = job.planTools({ ...DEFAULTS, ...settings });
    return {
        first: runFirst.map((s) => s.tool.id),
        later: runLater.map((s) => s.tool.id),
        all: [...runFirst, ...runLater].map((s) => s.tool.id),
    };
}

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

test('every optimizer can be switched off', () => {
    const off = {
        OptiPngEnabled: false, ZopfliEnabled: false, AdvPngEnabled: false,
        PngCrush2Enabled: false, JpegOptimEnabled: false, JpegTranEnabled: false,
        GuetzliEnabled: false, GifsicleEnabled: false, SvgoEnabled: false,
        SvgcleanerEnabled: false,
    };
    for (const type of ['png', 'jpeg', 'gif', 'svg']) {
        assert.deepStrictEqual(plan(type, off).all, [], `${type} should plan nothing`);
    }
});

test('repeat runs raise the effort level', () => {
    // Job.m increments the level when the file has been optimized before
    const first = plan('png', { PngCrush2Enabled: true, AdvPngLevel: 1 });
    const second = plan('png', { PngCrush2Enabled: true, AdvPngLevel: 1 }, { runCount: 1 });
    assert.ok(!first.all.includes('pngcrush'), 'level 1 drops pngcrush');
    assert.ok(second.all.includes('pngcrush'), 'level 2 keeps it');
});
