'use strict';

// The command line each optimizer is given, checked against the macOS worker it
// was ported from. This is the most valuable thing in the suite: a wrong flag
// does not raise an error, it makes the tool exit non-zero, which the job treats
// as "no improvement". A broken optimizer is therefore indistinguishable from an
// already-optimal file unless something asserts the arguments.
//
// Expectations below are taken from imageoptim/Backend/Workers/*.m, not from
// lib/tools.js, so that a change to the port shows up as a failure rather than
// being silently blessed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { captureArgs, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

test('oxipng — OxiPngWorker.m', async () => {
    const { args, tempPath, inputPath } = await captureArgs('oxipng');
    // optlevel = MAX(2, MIN(level, 6)); --strip=safe inserted first when
    // PngOutRemoveChunks is set
    assert.deepStrictEqual(args,
        ['--strip=safe', '-o4', '-i0', '-a', '--out', tempPath, '--', inputPath]);
});

test('oxipng — metadata kept when PngOutRemoveChunks is off', async () => {
    const { args } = await captureArgs('oxipng', { settings: { PngOutRemoveChunks: false } });
    assert.ok(!args.includes('--strip=safe'), 'must not strip when the setting is off');
    assert.strictEqual(args[0], '-o4');
});

test('oxipng — level is clamped to 2..6', async () => {
    assert.strictEqual((await captureArgs('oxipng', { level: 1 })).args[1], '-o2');
    assert.strictEqual((await captureArgs('oxipng', { level: 9 })).args[1], '-o6');
});

test('pngquant — PngquantWorker.m', async () => {
    const { args } = await captureArgs('pngquant', {
        settings: { LossyEnabled: true, PngMinQuality: 80 },
    });
    // speed = MIN(3, 7 - level); maxQuality = MIN(100, min + 20)
    assert.deepStrictEqual(args,
        ['256', '--skip-if-larger', '-s3', '--quality', '80-100', '-']);
});

test('pngquant — reads stdin and writes stdout', async () => {
    const { options, inputPath, tempPath } = await captureArgs('pngquant', {
        settings: { LossyEnabled: true },
    });
    assert.strictEqual(options.stdinPath, inputPath);
    assert.strictEqual(options.stdoutPath, tempPath);
});

test('zopflipng — ZopfliWorker.m', async () => {
    const { args, tempPath, inputPath } = await captureArgs('zopflipng');
    // iterations = 3 + 3 * level; timelimit capped by ZopfliMaxSeconds then
    // multiplied by 0.8 for the non-alternative strategy
    assert.deepStrictEqual(args, [
        '--timelimit=4', '--iterations=15', '--filters=0pme',
        '--lossy_transparent', '-y', inputPath, tempPath,
    ]);
});

test('zopflipng — keeps chunks when stripping is off', async () => {
    const { args } = await captureArgs('zopflipng', { settings: { PngOutRemoveChunks: false } });
    const keep = args.find((a) => a.startsWith('--keepchunks='));
    assert.ok(keep, '--keepchunks must be present when metadata is preserved');
    for (const chunk of ['tEXt', 'iCCP', 'acTL', 'fcTL']) {
        assert.ok(keep.includes(chunk), `${chunk} must be kept`);
    }
});

test('zopflipng — large files use the cheap filter and fewer iterations', async () => {
    const { args } = await captureArgs('zopflipng', { size: 400 * 1024 });
    assert.ok(args.includes('--filters=p'), 'large PNGs use --filters=p');
    assert.ok(args.includes('--iterations=10'), '5 + floor(15 / 3)');
});

test('advpng — AdvCompWorker.m', async () => {
    const { args, tempPath } = await captureArgs('advpng');
    // level clamped to 1..4; advpng rewrites the copy in place
    assert.deepStrictEqual(args, ['-4', '-z', '--', tempPath]);
});

test('pngcrush — PngCrushWorker.m', async () => {
    const { args, tempPath, inputPath } = await captureArgs('pngcrush', { size: 64 * 1024 });
    assert.deepStrictEqual(args, [
        '-rem', 'alla', '-nofilecheck', '-bail', '-blacken', '-reduce', '-cc',
        '--', inputPath, tempPath,
    ]);
});

test('pngcrush — small files get -brute', async () => {
    const { args } = await captureArgs('pngcrush', { size: 1024 });
    assert.strictEqual(args[0], '-brute', 'isSmall for PNG is under 2048 bytes');
});

test('jpegoptim — lossless by default', async () => {
    const { args, tempPath } = await captureArgs('jpegoptim', { type: 'jpeg' });
    assert.deepStrictEqual(args, ['--strip-all', '--all-normal', '-v', '--', tempPath]);
});

test('jpegoptim — lossy adds -m and switches to progressive', async () => {
    const { args } = await captureArgs('jpegoptim', {
        type: 'jpeg',
        settings: { LossyEnabled: true, JpegOptimMaxQuality: 70 },
    });
    assert.strictEqual(args[0], '-m70');
    assert.ok(args.includes('--all-progressive'));
    assert.ok(!args.includes('--all-normal'));
});

test('jpegoptim — metadata kept when JpegTranStripAll is off', async () => {
    const { args } = await captureArgs('jpegoptim', {
        type: 'jpeg', settings: { JpegTranStripAll: false },
    });
    assert.ok(args.includes('--strip-none'));
});

test('jpegtran — JpegtranWorker.m', async () => {
    const { args, tempPath, inputPath } = await captureArgs('jpegtran', { type: 'jpeg' });
    assert.deepStrictEqual(args,
        ['-copy', 'none', '-optimize', '-outfile', tempPath, inputPath]);
});

test('jpegtran — copies all markers when not stripping', async () => {
    const { args } = await captureArgs('jpegtran', {
        type: 'jpeg', settings: { JpegTranStripAll: false },
    });
    assert.deepStrictEqual(args.slice(0, 2), ['-copy', 'all']);
});

test('jpegtran — runs from the executable directory', async () => {
    const { options } = await captureArgs('jpegtran', { type: 'jpeg' });
    assert.strictEqual(options.cwd, path.dirname(options.exe));
});

test('guetzli — GuetzliWorker.m', async () => {
    const { args, tempPath } = await captureArgs('guetzli', {
        type: 'jpeg', size: 64 * 1024, settings: { GuetzliEnabled: true },
    });
    // quality falls back to 95 when lossy is off; memlimit 6000 unless the file is small
    assert.deepStrictEqual(args,
        ['--quality', '95', '--memlimit', '6000', tempPath, tempPath]);
});

test('guetzli — never drops below quality 84', async () => {
    const { args } = await captureArgs('guetzli', {
        type: 'jpeg', size: 64 * 1024,
        settings: { GuetzliEnabled: true, LossyEnabled: true, JpegOptimMaxQuality: 50 },
    });
    assert.deepStrictEqual(args.slice(0, 2), ['--quality', '84']);
});

test('gifsicle — GifsicleWorker.m', async () => {
    const { args, tempPath, inputPath } = await captureArgs('gifsicle', { type: 'gif' });
    assert.deepStrictEqual(args, [
        '-o', tempPath, '--no-interlace', '-O3', '--careful',
        '--no-comments', '--no-names', '--same-delay', '--same-loopcount',
        '--no-warnings', '--', inputPath,
    ]);
});

test('gifsicle — the interlaced variant differs by one flag', async () => {
    const { args } = await captureArgs('gifsicle-interlaced', { type: 'gif' });
    assert.ok(args.includes('--interlace'));
    assert.ok(!args.includes('--no-interlace'));
});

test('gifsicle — lossy adds --lossy with the macOS curve', async () => {
    const { args } = await captureArgs('gifsicle', {
        type: 'gif', size: 64 * 1024,
        settings: { LossyEnabled: true, GifQuality: 80 },
        extra: { lossyGif: true },
    });
    // GifsicleWorker.m: int loss = pow(100 - quality, 1.8) / 5.0
    //   pow(20, 1.8) = 219.6, / 5 = 43.9, truncated by the int assignment to 43
    // then, being neither small nor large: loss = 1 + loss / 2, integer division
    //   1 + 43 / 2 = 1 + 21 = 22
    assert.strictEqual(args[0], '--lossy=22');
});

test('svgcleaner — SvgcleanerWorker.m', async () => {
    const { args, options, inputPath, tempPath } = await captureArgs('svgcleaner', { type: 'svg' });
    assert.deepStrictEqual(args, ['--stdout', '--', inputPath]);
    assert.strictEqual(options.stdoutPath, tempPath, 'output is captured from stdout');
});

test('svgo — runs the bundle through this executable as node', async () => {
    const { args, options, inputPath, tempPath } = await captureArgs('svgo', { type: 'svg' });
    assert.deepStrictEqual(args, ['/fake/resources/svgo.js', '0', inputPath, tempPath]);
    assert.strictEqual(options.exe, process.execPath);
    assert.strictEqual(options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('svgo — lossy flag is passed through', async () => {
    const { args } = await captureArgs('svgo', { type: 'svg', settings: { LossyEnabled: true } });
    assert.strictEqual(args[1], '1');
});
