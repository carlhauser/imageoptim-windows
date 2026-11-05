// Measures the optimizers on a set of images: how many bytes each tool takes
// off, how long it takes, and how often it is the one that wins.
//
//   node scripts/bench.mjs <folder or image>...
//
// Runs with the default settings against the executables in resources\bin
// (or IMAGEOPTIM_BIN). Every tool runs on the untouched file, the way the
// lossless tools race one another; "chain" rows run the current plan for a
// PNG in order - Zopfli first, then the rest on its output - and the variants
// a change would replace it with, so they can be compared on the same files.
// Nothing is written beside the images: they are copied to a temp folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');

// tools.js reaches for electron only for Guetzli's decode, which this skips
const Module = require('module');
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
    if (request === 'electron') return {};
    return realLoad.call(this, request, ...rest);
};

const tools = require(path.join(root, 'lib', 'tools.js'));
const run = require(path.join(root, 'lib', 'run.js'));
const { makeResolver, expandPaths } = require(path.join(root, 'lib', 'queue.js'));
const { detectType, inspect, HEADER_BYTES } = require(path.join(root, 'lib', 'filetype.js'));
const { looksComplete } = require(path.join(root, 'lib', 'validate.js'));
const { DEFAULTS } = require(path.join(root, 'lib', 'settings.js'));

const binDir = process.env.IMAGEOPTIM_BIN || path.join(root, 'resources', 'bin');
const resolve = makeResolver(binDir);
const inputs = process.argv.slice(2);
if (!inputs.length) {
    console.error('usage: node scripts/bench.mjs <folder or image>...');
    process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imageoptim-bench-'));
let counter = 0;
const tempFile = (ext = '.temp') => path.join(tmp, `t${++counter}${ext}`);
const settings = { ...DEFAULTS };

// One tool on one file. Returns { size, ms } or null.
async function runOne(tool, input, type, extra = {}) {
    const resolved = resolve(tool);
    if (!resolved) return null;
    const temp = tempFile();
    const header = fs.readFileSync(input).subarray(0, HEADER_BYTES);
    const started = performance.now();
    let result = null;
    try {
        result = await tool.run({
            input: { path: input, byteSize: fs.statSync(input).size, type },
            temp, settings, level: Number(settings.AdvPngLevel),
            alternativeStrategy: false, lossyGif: false,
            features: inspect(type, input, header),
            signal: new AbortController().signal,
            threads: os.availableParallelism(),
            exe: resolved.exe, script: resolved.script, helpers: resolved.helpers,
            ...extra,
        });
    } catch (err) {
        result = null;
    }
    const ms = performance.now() - started;
    if (!result || !result.size || !looksComplete(type, temp)) return { size: null, ms, temp: null };
    return { size: result.size, ms, temp };
}

// oxipng with its own Zopfli, the candidate to replace zopflipng's pass
async function oxipngZopfli(input) {
    const exe = resolve(tools.byId('oxipng'));
    if (!exe) return null;
    const out = tempFile('.png');
    const started = performance.now();
    const { code } = await run.runTool({
        exe: exe.exe,
        // -z: OxiPNG 10 renamed its Zopfli flag from -Z
        args: ['-o', 'max', '-z', '--fast', '-i0', '-a', '--strip=safe', '--out', out, '--', input],
    });
    const ms = performance.now() - started;
    if (code !== 0 || !looksComplete('png', out)) return { size: null, ms };
    return { size: fs.statSync(out).size, ms };
}

const stats = new Map(); // row -> { files, bytesIn, bytesOut, ms, wins }
function note(row, before, size, ms, won) {
    if (!stats.has(row)) stats.set(row, { files: 0, ran: 0, saved: 0, ms: 0, wins: 0 });
    const s = stats.get(row);
    s.files += 1;
    s.ms += ms;
    if (size && size < before) {
        s.ran += 1;
        s.saved += before - size;
    }
    if (won) s.wins += 1;
}

const files = await expandPaths(inputs.map((p) => path.resolve(p)), { limit: 5000 });
let total = 0;
for (const original of files) {
    const header = fs.readFileSync(original).subarray(0, HEADER_BYTES);
    const type = detectType(header, original);
    if (!type) continue;
    const input = tempFile(path.extname(original));
    fs.copyFileSync(original, input);
    const before = fs.statSync(input).size;
    total += 1;

    const candidates = tools.ALL.filter((t) => t.types.includes(type) && !t.lossy && t.id !== 'webpmux');
    if (type === 'png') candidates.push(tools.byId('zopflipng'));
    const results = [];
    for (const tool of candidates) {
        const r = await runOne(tool, input, type);
        if (r) results.push({ row: `${type} ${tool.id}`, ...r });
    }
    // Only a result smaller than the file counts: the app throws away the rest
    const best = Math.min(...results.filter((r) => r.size && r.size < before).map((r) => r.size));
    for (const r of results) note(r.row, before, r.size, r.ms, r.size === best);

    // Zopfli only runs on PNGs up to ZopfliSkipAboveKB, so that is where a
    // replacement for it has to be measured
    if (type === 'png' && before <= Number(settings.ZopfliSkipAboveKB) * 1024) {
        // The plan as it stands: Zopfli first, then oxipng and AdvPNG race on
        // its output; against oxipng with its own Zopfli doing both at once
        const zopfli = results.find((r) => r.row === 'png zopflipng');
        let chainSize = zopfli && zopfli.size ? zopfli.size : before;
        let chainMs = zopfli ? zopfli.ms : 0;
        const from = zopfli && zopfli.temp ? zopfli.temp : input;
        const after = [];
        for (const id of ['oxipng', 'advpng']) {
            const r = await runOne(tools.byId(id), from, type);
            if (r) {
                chainMs += r.ms;
                if (r.size) after.push(r.size);
            }
        }
        chainSize = Math.min(chainSize, ...after);
        const z = await oxipngZopfli(input);
        const bestChain = Math.min(chainSize, z && z.size ? z.size : Infinity);
        note('png chain: zopflipng then oxipng/advpng', before, chainSize, chainMs, chainSize === bestChain);
        if (z) note('png variant: oxipng -o max -z alone', before, z.size, z.ms, z.size && z.size === bestChain);
    }
    const won = results.filter((r) => r.size === best).map((r) => r.row.split(' ')[1]).join(', ');
    const bestKb = Number.isFinite(best) ? `${(best / 1024).toFixed(1)} KB` : 'nothing smaller';
    console.log(`${path.basename(original)}  ${(before / 1024).toFixed(1)} KB -> ${bestKb}  (${won || '-'})`);
}

console.log(`\n\n${'row'.padEnd(44)} files  smaller  saved KB  wins  seconds`);
for (const [row, s] of [...stats.entries()].sort()) {
    console.log(`${row.padEnd(44)} ${String(s.files).padStart(5)}  ${String(s.ran).padStart(7)}  ${(s.saved / 1024).toFixed(1).padStart(8)}  ${String(s.wins).padStart(4)}  ${(s.ms / 1000).toFixed(1).padStart(7)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
