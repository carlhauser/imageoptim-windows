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
const { DEFAULTS } = require('../lib/settings');
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
        const src = sample(type);
        if (!src) {
            assert.fail(`no ${type} sample available in the repository`);
        }

        const input = path.join(scratch(), `bin-${tool.id}-in${path.extname(src)}`);
        fs.copyFileSync(src, input);
        // .temp, matching lib/job.js tempPath. The suffix matters: advpng
        // refuses a .tmp input outright. See the regression test below.
        const temp = path.join(scratch(), `bin-${tool.id}-out.temp`);

        // Run for real, but keep the exit code and output for inspection.
        let seen = null;
        const realRunTool = run.runTool;
        run.runTool = async (options) => {
            const result = await realRunTool(options);
            seen = result;
            return result;
        };

        try {
            await tool.run({
                input: { path: input, byteSize: fs.statSync(input).size, type },
                temp,
                settings: { ...DEFAULTS, LossyEnabled: true, GuetzliEnabled: true },
                level: 4,
                alternativeStrategy: false,
                lossyGif: tool.id === 'gifsicle',
                signal: new AbortController().signal,
                exe: resolved.exe,
                script: resolved.script,
            });
        } finally {
            run.runTool = realRunTool;
        }

        assert.ok(seen, `${tool.id} never spawned anything`);
        assert.notStrictEqual(seen.code, 127, `${tool.id} could not be executed`);

        // pngquant uses 98 and 99 to decline an image; everything else should
        // succeed on a valid input.
        const benign = tool.id === 'pngquant' ? [0, 98, 99] : [0];
        const rejected = /unrecognized option|unknown option|unrecognised option|invalid option/i;
        const hint = rejected.test(seen.output)
            ? ' - it reported an option it did not recognise'
            : '';
        assert.ok(benign.includes(seen.code),
            `${tool.id} exited ${seen.code}${hint}:\n${seen.output.slice(0, 400)}`);
    });
}

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
