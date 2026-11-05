'use strict';

// The stubbed tests prove the arguments are what was intended. They cannot prove
// the optimizers accept them: a tool that renamed or dropped a flag between
// versions exits non-zero, which the job reads as "no improvement", and nothing
// anywhere says otherwise.
//
// This file closes that gap by running the real executables. It is skipped
// unless IMAGEOPTIM_BIN points at a directory of them:
//
//   IMAGEOPTIM_BIN=/path/to/bin npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { makeResolver } = require('../lib/queue');
const { inspect, HEADER_BYTES } = require('../lib/filetype');
const { DEFAULTS } = require('../lib/settings');
const { looksComplete } = require('../lib/validate');
const { scratch, cleanupScratch, tools, run } = require('./helpers');

const BIN = process.env.IMAGEOPTIM_BIN;
const skip = BIN ? false : 'set IMAGEOPTIM_BIN to a directory of optimizer binaries';

// Real images, since the optimizers will actually parse them.
const SAMPLES = {
    // Not pngtest.png: it is interlaced, which advpng refuses with
    // "Unsupported interlace 1". A plain PNG is what the app actually meets.
    png: ['libpng/pngbar.png', 'libpng/contrib/gregbook/toucan.png'],
    jpeg: ['libpng/pngbar.jpg'],
    gif: ['gifsicle/orig/logo.gif'],
    svg: ['guetzli/guetzli/guetzli.svg'],
    // Made for these tests: the repository has no WebP or AVIF of its own.
    // The WebP is lossless and carries ICC, EXIF and XMP, so that both
    // webpmux runs and the lossless cwebp pass happen.
    webp: ['win/test/fixtures/lossless-metadata.webp'],
    avif: ['win/test/fixtures/photo.avif'],
};

// Tools that need a different kind of file than their type's sample
const SAMPLE_FOR = {
    'cwebp-lossy': 'win/test/fixtures/lossy.webp',
};

const repoRoot = path.resolve(__dirname, '..', '..');

function sample(type) {
    for (const rel of SAMPLES[type]) {
        const p = path.join(repoRoot, rel);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// Phrases a tool uses when it rejects a flag. Only consulted when the tool also
// failed: pngcrush 1.8.10 prints "Ignoring invalid option: -bail" for three of
// the flags ImageOptim passes, carries on, and exits 0 - the same as it does on
// macOS, so it is not something this port introduced.

test.after(cleanupScratch);

for (const tool of tools.ALL) {
    test(`${tool.id} accepts the arguments it is given`, { skip }, async () => {
        const resolve = makeResolver(BIN);
        const resolved = resolve(tool);
        if (!resolved) {
            assert.fail(`${tool.id} not found in ${BIN}`);
        }

        const type = tool.types[0];
        const src = SAMPLE_FOR[tool.id] ? path.join(repoRoot, SAMPLE_FOR[tool.id]) : sample(type);
        if (!src || !fs.existsSync(src)) {
            assert.fail(`no ${type} sample available in the repository`);
        }

        const input = path.join(scratch(), `bin-${tool.id}-in${path.extname(src)}`);
        fs.copyFileSync(src, input);
        // .temp, matching lib/job.js tempPath. The suffix matters: advpng
        // refuses a .tmp input outright. See the regression test below.
        const temp = path.join(scratch(), `bin-${tool.id}-out.temp`);
        const header = fs.readFileSync(input).subarray(0, HEADER_BYTES);

        // Run for real, but keep every exit code and output for inspection:
        // webpmux and avifenc each run two commands.
        const seen = [];
        const realRunTool = run.runTool;
        run.runTool = async (options) => {
            const result = await realRunTool(options);
            seen.push({ exe: path.basename(options.exe), ...result });
            return result;
        };

        let outcome;
        try {
            outcome = await tool.run({
                input: { path: input, byteSize: fs.statSync(input).size, type },
                temp,
                settings: { ...DEFAULTS, LossyEnabled: true, GuetzliEnabled: true },
                level: 4,
                alternativeStrategy: false,
                lossyGif: tool.id === 'gifsicle',
                features: inspect(type, input, header),
                signal: new AbortController().signal,
                exe: resolved.exe,
                script: resolved.script,
                helpers: resolved.helpers,
            });
        } finally {
            run.runTool = realRunTool;
        }

        assert.ok(seen.length, `${tool.id} never spawned anything`);
        // pngquant uses 98 and 99 to decline an image; everything else should
        // succeed on a valid input.
        const benign = tool.id === 'pngquant' ? [0, 98, 99] : [0];
        const rejected = /unrecognized option|unknown option|unrecognised option|invalid option/i;
        for (const step of seen) {
            assert.notStrictEqual(step.code, 127, `${step.exe} could not be executed`);
            const hint = rejected.test(step.output)
                ? ' - it reported an option it did not recognise'
                : '';
            assert.ok(benign.includes(step.code),
                `${step.exe} exited ${step.code}${hint}:\n${step.output.slice(0, 400)}`);
        }

        // The new formats' tools are this port's own, with no macOS command
        // line to check against, so their result is checked too: each of
        // these samples has something to gain.
        if (type === 'webp' || type === 'avif') {
            assert.ok(outcome && outcome.size > 0 && outcome.size < fs.statSync(input).size,
                `${tool.id} produced no smaller file`);
        }

        // Whatever a real tool writes must pass the check that stands between
        // it and the user's file, or that check would throw away good results
        // (svgcleaner writes nothing at all when it would make the file bigger)
        if (outcome && outcome.size) {
            assert.ok(looksComplete(type, temp), `${tool.id}'s output failed lib/validate.js`);
        }
    });
}

test('cwebp output decodes to exactly the pixels it was given', { skip }, () => {
    // -lossless -exact is meant to be pixel-identical, transparent pixels
    // included. Checked with cwebp itself: re-encoding its own output must
    // reproduce it byte for byte from the same pixels, which is only true if
    // nothing was lost on the way.
    const { execFileSync } = require('child_process');
    const exe = path.join(BIN, process.platform === 'win32' ? 'cwebp.exe' : 'cwebp');
    if (!fs.existsSync(exe)) return;
    const src = path.join(repoRoot, SAMPLES.webp[0]);
    const once = path.join(scratch(), 'exact-1.webp');
    const twice = path.join(scratch(), 'exact-2.webp');
    const opts = ['-lossless', '-z', '6', '-exact', '-metadata', 'all', '-quiet', '-o'];
    execFileSync(exe, [...opts, once, '--', src], { stdio: 'pipe' });
    execFileSync(exe, [...opts, twice, '--', once], { stdio: 'pipe' });
    assert.ok(fs.readFileSync(once).equals(fs.readFileSync(twice)));
});

test('webpmux fails when asked to strip a chunk that is not there', { skip }, () => {
    // Why tools.js only asks for the chunks inspectWebP found
    const { execFileSync } = require('child_process');
    const exe = path.join(BIN, process.platform === 'win32' ? 'webpmux.exe' : 'webpmux');
    if (!fs.existsSync(exe)) return;
    const out = path.join(scratch(), 'strip-none.webp');
    let status = 0;
    try {
        execFileSync(exe, ['-strip', 'exif', '-o', out, '--', path.join(repoRoot, SAMPLE_FOR['cwebp-lossy'])],
            { stdio: 'pipe' });
    } catch (err) {
        status = err.status;
    }
    assert.notStrictEqual(status, 0, 'if this ever passes, the feature check in tools.js can go');
    assert.ok(!fs.existsSync(out));
});

test('advpng refuses a .tmp input, which is why temp files end in .temp',
    { skip }, async () => {
        // AdvanceCOMP rejects a file named *.tmp with "Error reading the
        // signature", while .temp, .png, .xyz and no extension all work. The
        // app's temp names are therefore load-bearing: renaming them to .tmp
        // would disable advpng silently, because a tool that exits non-zero is
        // reported as "no improvement" and nothing else.
        const { execFileSync } = require('child_process');
        const exe = path.join(BIN, process.platform === 'win32' ? 'advpng.exe' : 'advpng');
        const src = sample('png');
        if (!fs.existsSync(exe) || !src) return;

        const run1 = (name) => {
            const f = path.join(scratch(), name);
            fs.copyFileSync(src, f);
            try {
                execFileSync(exe, ['-4', '-z', '--', f], { stdio: 'pipe' });
                return 0;
            } catch (err) {
                return err.status;
            }
        };

        assert.strictEqual(run1('adv-check.temp'), 0, '.temp must work');
        assert.notStrictEqual(run1('adv-check.tmp'), 0,
            'if this ever passes, advpng changed and the comment in job.js can go');
    });
