// Runs a packaged build on one image of each format and checks the files on
// disk: smaller, still whole, and SVG still an SVG.
//
//   node scripts/smoke.mjs [path\to\ImageOptim.exe]
//
// The default is dist\win-unpacked\ImageOptim.exe. The packaged app cannot be
// debugged from outside (its Electron fuses), so this drives it the way a user
// does: files on the command line, results in the files. It is what CI runs
// after packaging: both broken releases this port has had - SVGO missing, and
// optimizers that needed DLLs nobody shipped - built and packaged fine and
// only failed here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn, execFileSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const win = path.resolve(here, '..');
const repo = path.resolve(win, '..');
const exe = path.resolve(process.argv[2] || path.join(win, 'dist', 'win-unpacked', 'ImageOptim.exe'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { looksComplete } = await import(`file:///${path.join(win, 'lib', 'validate.js').replace(/\\/g, '/')}`)
    .then((m) => m.default || m);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imageoptim-smoke-'));
const images = path.join(dir, 'images');
fs.mkdirSync(images);

// --------------------------------------------------- an image of each format

const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
};

// A PNG stored without compression, so there is something to gain
function storedPng(src, dst) {
    const png = fs.readFileSync(src);
    const keep = [];
    const idat = [];
    for (let off = 8; off < png.length;) {
        const len = png.readUInt32BE(off);
        const type = png.toString('ascii', off + 4, off + 8);
        if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
        else if (type !== 'IEND') keep.push(png.subarray(off, off + 12 + len));
        off += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    fs.writeFileSync(dst, Buffer.concat([png.subarray(0, 8), ...keep,
        chunk('IDAT', zlib.deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]));
}

const bin = path.join(path.dirname(exe), 'resources', 'bin');
const samples = {
    'stored.png': (dst) => storedPng(path.join(repo, 'libpng', 'pngbar.png'), dst),
    // Plain Huffman tables, which jpegtran -optimize improves on
    'photo.jpg': (dst) => execFileSync(path.join(bin, 'jpegtran.exe'),
        ['-revert', '-copy', 'all', '-outfile', dst, path.join(repo, 'libpng', 'pngbar.jpg')]),
    // A comment block before the trailer, which gifsicle --no-comments drops
    'logo.gif': (dst) => {
        const gif = fs.readFileSync(path.join(repo, 'gifsicle', 'orig', 'logo.gif'));
        const text = Buffer.from('Saved by an example editor, with a comment nobody needs.');
        fs.writeFileSync(dst, Buffer.concat([gif.subarray(0, -1),
            Buffer.from([0x21, 0xfe, text.length]), text, Buffer.from([0x00, 0x3b])]));
    },
    'padded.svg': (dst) => fs.writeFileSync(dst, '<?xml version="1.0"?>\n<!-- editor -->\n'
        + '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">\n  <g>\n'
        + '    <g><rect x="1.000000" y="1.000000" width="5.000000" height="5.000000"/></g>\n  </g>\n</svg>\n'),
    'lossless.webp': (dst) => fs.copyFileSync(path.join(win, 'test', 'fixtures', 'lossless-metadata.webp'), dst),
};
for (const [name, make] of Object.entries(samples)) make(path.join(images, name));

// ------------------------------------------------------------- run the app

const before = Object.fromEntries(Object.keys(samples).map((f) => [f, fs.statSync(path.join(images, f)).size]));
const profile = path.join(dir, 'profile');
fs.mkdirSync(profile);
// Svgcleaner off, so the SVG can only shrink if SVGO works: it runs in a
// utility process from inside app.asar, which nothing else here exercises
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ version: 1, SvgcleanerEnabled: false }));
const child = spawn(exe, [`--user-data-dir=${profile}`, images], { stdio: 'ignore' });
let exited = null;
child.on('exit', (code) => { exited = code; });

const sizes = () => Object.fromEntries(Object.keys(samples).map((f) => [f, fs.statSync(path.join(images, f)).size]));
let after = sizes();
for (let i = 0; i < 240 && exited === null; i++) {
    await sleep(500);
    after = sizes();
    if (Object.keys(before).every((f) => after[f] < before[f])) break;
}
await sleep(1000); // a last save in progress
after = sizes();
try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); } catch { /* gone */ }

// ----------------------------------------------------------------- results

const type = { png: 'png', jpg: 'jpeg', gif: 'gif', svg: 'svg', webp: 'webp' };
let failed = 0;
for (const name of Object.keys(samples)) {
    const file = path.join(images, name);
    const whole = looksComplete(type[path.extname(name).slice(1)], file);
    const ok = after[name] < before[name] && whole;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${before[name]} -> ${after[name]} bytes${whole ? '' : ', not a whole image'}`);
}
if (!/xmlns=/.test(fs.readFileSync(path.join(images, 'padded.svg'), 'utf8'))) {
    console.log('FAIL padded.svg lost its namespace');
    failed += 1;
}
if (exited !== null) {
    console.log(`FAIL the app exited by itself, code ${exited}`);
    failed += 1;
}
const log = path.join(profile, 'logs', 'main.log');
if (fs.existsSync(log)) console.log(`\nmain.log:\n${fs.readFileSync(log, 'utf8').slice(-2000)}`);

await sleep(500);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
