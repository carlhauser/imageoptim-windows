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

test('pngquant — speed stays within the 1..10 it accepts at the highest efforts', async () => {
    // Effort 7, and 6 or 7 plus Optimize Again, used to give -s0 and -s-1,
    // which pngquant refuses: lossy PNG then did nothing at all.
    for (const level of [6, 7, 8]) {
        const { args } = await captureArgs('pngquant', {
            settings: { LossyEnabled: true, PngMinQuality: 80 }, level,
        });
        assert.strictEqual(args[2], '-s1', `level ${level}`);
    }
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

// ------------------------------------------------------------------ WebP, AVIF
//
// The macOS app has no WebP or AVIF worker, so these are this port's own
// command lines; the measurements behind them are in win/README.md. What
// matters most is the same: a flag the tool rejects makes it exit non-zero,
// which reads as "no improvement".

const { parseAvifdecSummary, webpLosslessEffort, avifSpeed } = require('../lib/tools');

test('cwebp — lossless, pixel for pixel, keeping only the ICC profile', async () => {
    const { args, inputPath, tempPath } = await captureArgs('cwebp', { type: 'webp' });
    assert.deepStrictEqual(args, [
        '-lossless', '-z', '9', '-exact', '-mt', '-metadata', 'icc',
        '-quiet', '-o', tempPath, '--', inputPath,
    ]);
});

test('cwebp — keeps EXIF and XMP when stripping is off', async () => {
    const { args } = await captureArgs('cwebp', { type: 'webp', settings: { WebPAvifStripMetadata: false } });
    assert.strictEqual(args[args.indexOf('-metadata') + 1], 'all');
});

test('cwebp — effort 9, but 7 above 2 MB and 6 at the lowest levels', () => {
    assert.strictEqual(webpLosslessEffort(4, 100 * 1024), 9);
    assert.strictEqual(webpLosslessEffort(4, 3 * 1024 * 1024), 7);
    assert.strictEqual(webpLosslessEffort(2, 100 * 1024), 6);
});

test('cwebp lossy — re-encodes at WebPQuality with the slowest method', async () => {
    const { args, inputPath, tempPath, result } = await captureArgs('cwebp-lossy', {
        type: 'webp', settings: { LossyEnabled: true, WebPQuality: 75 },
    });
    assert.deepStrictEqual(args, [
        '-q', '75', '-m', '6', '-mt', '-metadata', 'icc',
        '-quiet', '-o', tempPath, '--', inputPath,
    ]);
    assert.strictEqual(result.label, 'cwebp 75%');
});

test('cwebp lossy — a re-encode saving under 5% is not worth the loss', async () => {
    const tiny = await captureArgs('cwebp-lossy', {
        type: 'webp', size: 1000, outSize: 960, settings: { LossyEnabled: true },
    });
    assert.strictEqual(tiny.result, null, '4% smaller is refused');
    const enough = await captureArgs('cwebp-lossy', {
        type: 'webp', size: 1000, outSize: 950, settings: { LossyEnabled: true },
    });
    assert.ok(enough.result, '5% smaller is kept');
});

test('webpmux — one -strip per run, EXIF then XMP, chained', async () => {
    const { calls, inputPath, tempPath } = await captureArgs('webpmux', {
        type: 'webp', extra: { features: { exif: true, xmp: true } },
    });
    // Two -strip options in one run are an error ("Multiple '-strip'
    // arguments specified"), so it takes two
    assert.deepStrictEqual(calls.map((c) => c.args), [
        ['-strip', 'exif', '-o', `${tempPath}.exif`, '--', inputPath],
        ['-strip', 'xmp', '-o', tempPath, '--', `${tempPath}.exif`],
    ]);
});

test('webpmux — asks only for the chunks the file has', async () => {
    const { calls, inputPath, tempPath } = await captureArgs('webpmux', {
        type: 'webp', extra: { features: { exif: false, xmp: true } },
    });
    // Stripping a chunk that is not there fails with WEBP_MUX_NOT_FOUND
    assert.deepStrictEqual(calls.map((c) => c.args), [['-strip', 'xmp', '-o', tempPath, '--', inputPath]]);
});

const AVIFDEC_SUMMARY = [
    'Image decoded: in.avif',
    ' * Resolution     : 1600x1200',
    ' * Bit Depth      : 10',
    ' * Format         : YUV420',
    ' * Alpha          : Absent',
    ' * CLLI           : 470, 263',
    ' * Gain map       : Absent',
    'Wrote PNG: out.png',
].join('\n');

test('avifdec — the summary avifenc needs is read from its output', () => {
    assert.deepStrictEqual(parseAvifdecSummary(AVIFDEC_SUMMARY),
        { depth: 10, format: '420', gainMap: false, clli: '470,263' });
    const gain = parseAvifdecSummary(' * Bit Depth      : 8\n * Format         : YUV444\n'
        + ' * Gain map       : 400x300 pixels, 8 bit, YUV444\n');
    assert.strictEqual(gain.gainMap, true);
});

test('avifenc — decodes to PNG with avifdec, then re-encodes like the original', async () => {
    const { calls, inputPath, tempPath, result } = await captureArgs('avifenc', {
        type: 'avif',
        settings: { LossyEnabled: true, AvifQuality: 60 },
        output: AVIFDEC_SUMMARY,
        extra: { helpers: { avifdec: '/fake/bin/avifdec' } },
    });
    const decoded = `${tempPath}.png`;
    assert.strictEqual(calls[0].exe, '/fake/bin/avifdec');
    assert.deepStrictEqual(calls[0].args, ['--sato', '--png-compress', '0', '-d', '16', '--', inputPath, decoded]);
    // The original's subsampling and depth, or a 4:2:0 10-bit photo would
    // come back 4:4:4 and 12-bit; CLLI is what PNG cannot carry
    assert.deepStrictEqual(calls[1].args, [
        '-q', '60', '-s', '6', '-y', '420', '-d', '10', '--clli', '470,263',
        '--ignore-exif', '--ignore-xmp', '--', decoded, tempPath,
    ]);
    assert.strictEqual(result.label, 'avifenc 60%');
});

test('avifenc — keeps EXIF and XMP when stripping is off', async () => {
    const { args } = await captureArgs('avifenc', {
        type: 'avif',
        settings: { LossyEnabled: true, WebPAvifStripMetadata: false },
        output: AVIFDEC_SUMMARY,
        extra: { helpers: { avifdec: '/fake/bin/avifdec' } },
    });
    assert.ok(!args.includes('--ignore-exif') && !args.includes('--ignore-xmp'));
});

test('avifenc — leaves a 16-bit sample-transform file alone', async () => {
    const { calls, result } = await captureArgs('avifenc', {
        type: 'avif',
        settings: { LossyEnabled: true },
        output: ' * Bit Depth      : 16\n * Format         : YUV444\n * Gain map       : Absent\n',
        extra: { helpers: { avifdec: '/fake/bin/avifdec' } },
    });
    assert.strictEqual(calls.length, 1, 'avifenc must not run: it encodes at most 12 bits');
    assert.strictEqual(result, null);
});

test('avifenc — leaves a file with a gain map alone', async () => {
    const { calls, result } = await captureArgs('avifenc', {
        type: 'avif',
        settings: { LossyEnabled: true },
        output: ' * Bit Depth      : 8\n * Format         : YUV444\n * Gain map       : 400x300 pixels\n',
        extra: { helpers: { avifdec: '/fake/bin/avifdec' } },
    });
    assert.strictEqual(calls.length, 1, 'avifenc must not run');
    assert.strictEqual(result, null);
});

test('avifenc — speed 6 at the default effort, 4 at the highest', () => {
    assert.strictEqual(avifSpeed(4), 6);
    assert.strictEqual(avifSpeed(5), 5);
    assert.strictEqual(avifSpeed(7), 4);
    assert.strictEqual(avifSpeed(1), 8);
});

// ------------------------------------------------------------- thread budget
//
// The multi-threaded tools are told how many cores they may use
// (lib/semaphore.js threadsPerSlot); left alone, each takes them all.

test('oxipng — -t and RAYON_NUM_THREADS when given a thread budget', async () => {
    const { args, options, tempPath, inputPath } = await captureArgs('oxipng', { extra: { threads: 3 } });
    assert.deepStrictEqual(args,
        ['--strip=safe', '-o4', '-i0', '-a', '-t', '3', '--out', tempPath, '--', inputPath]);
    assert.deepStrictEqual(options.env, { RAYON_NUM_THREADS: '3' });
});

test('pngquant — RAYON_NUM_THREADS when given a thread budget', async () => {
    const { options } = await captureArgs('pngquant', {
        settings: { LossyEnabled: true }, extra: { threads: 2 },
    });
    assert.deepStrictEqual(options.env, { RAYON_NUM_THREADS: '2' });
});

test('cwebp — no -mt with a single core, -mt with more', async () => {
    const one = await captureArgs('cwebp', { type: 'webp', extra: { threads: 1 } });
    assert.ok(!one.args.includes('-mt'));
    const four = await captureArgs('cwebp', { type: 'webp', extra: { threads: 4 } });
    assert.ok(four.args.includes('-mt'));
    const lossy = await captureArgs('cwebp-lossy', {
        type: 'webp', settings: { LossyEnabled: true }, extra: { threads: 1 }, outSize: 10,
    });
    assert.ok(!lossy.args.includes('-mt'));
});

test('avifenc and avifdec — -j with a thread budget', async () => {
    const { calls } = await captureArgs('avifenc', {
        type: 'avif',
        settings: { LossyEnabled: true, AvifQuality: 60 },
        output: AVIFDEC_SUMMARY,
        extra: { helpers: { avifdec: '/fake/bin/avifdec' }, threads: 5 },
    });
    for (const call of calls) {
        const at = call.args.indexOf('-j');
        assert.ok(at >= 0 && call.args[at + 1] === '5', call.args.join(' '));
        assert.ok(at < call.args.indexOf('--'), 'before the file names');
    }
});
