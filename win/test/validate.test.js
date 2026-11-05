'use strict';

// The last check before an optimizer's output may replace a file
// (lib/validate.js): whole images pass, and the same images cut short fail.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { looksComplete, hasRoomFor } = require('../lib/validate');
const { scratch, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

const repo = path.resolve(__dirname, '..', '..');
const SAMPLES = {
    png: path.join(repo, 'libpng', 'pngbar.png'),
    jpeg: path.join(repo, 'libpng', 'pngbar.jpg'),
    gif: path.join(repo, 'gifsicle', 'orig', 'logo.gif'),
    svg: path.join(repo, 'guetzli', 'guetzli', 'guetzli.svg'),
    webp: path.join(__dirname, 'fixtures', 'lossy.webp'),
    avif: path.join(__dirname, 'fixtures', 'photo.avif'),
};

function copyOf(type, transform = (b) => b) {
    const file = path.join(scratch(), `v-${type}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(file, transform(fs.readFileSync(SAMPLES[type])));
    return file;
}

for (const [type, sample] of Object.entries(SAMPLES)) {
    test(`${type} — a whole file passes, and one cut short does not`, { skip: !fs.existsSync(sample) && 'sample missing' }, () => {
        assert.strictEqual(looksComplete(type, copyOf(type)), true, 'the sample itself');
        for (const keep of [0.5, 0.9]) {
            const cut = copyOf(type, (b) => b.subarray(0, Math.floor(b.length * keep)));
            assert.strictEqual(looksComplete(type, cut), false, `cut to ${keep * 100}%`);
        }
        const oneShort = copyOf(type, (b) => b.subarray(0, b.length - 1));
        assert.strictEqual(looksComplete(type, oneShort), false, 'one byte short');
    });
}

test('an empty file, a missing file and the wrong format all fail', () => {
    const empty = path.join(scratch(), 'empty.png');
    fs.writeFileSync(empty, '');
    assert.strictEqual(looksComplete('png', empty), false);
    assert.strictEqual(looksComplete('png', path.join(scratch(), 'nope.png')), false);
    assert.strictEqual(looksComplete('png', copyOf('jpeg')), false);
    assert.strictEqual(looksComplete('jpeg', copyOf('gif')), false);
});

test('svg — a self-closed root counts as whole; text that never opens <svg does not', () => {
    const write = (text) => {
        const file = path.join(scratch(), `s-${Math.random().toString(16).slice(2)}.svg`);
        fs.writeFileSync(file, text);
        return file;
    };
    assert.strictEqual(looksComplete('svg', write('<svg xmlns="http://www.w3.org/2000/svg"/>\n')), true);
    assert.strictEqual(looksComplete('svg', write('<?xml version="1.0"?>\n<svg width="1"><g/></svg>')), true);
    assert.strictEqual(looksComplete('svg', write('<svg width="1"><g/></sv')), false);
    assert.strictEqual(looksComplete('svg', write('hello world, not an image')), false);
});

test('a type with no check passes', () => {
    assert.strictEqual(looksComplete('tiff', copyOf('png')), true);
});

test('hasRoomFor — the temp folder has room for a small file but not for an impossible one', () => {
    assert.strictEqual(hasRoomFor(os.tmpdir(), 1024), true);
    assert.strictEqual(hasRoomFor(os.tmpdir(), Number.MAX_SAFE_INTEGER), false);
    assert.strictEqual(hasRoomFor(path.join(scratch(), 'no', 'such', 'folder'), 1024), true, 'unknown is not full');
});
