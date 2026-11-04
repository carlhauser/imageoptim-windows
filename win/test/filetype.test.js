'use strict';

// Which format a file is, and for WebP and AVIF what the plan needs to know
// about it: lossless or lossy, animated, which metadata it carries.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    detectType, inspectWebP, inspectAvif, typeFromExtension, EXTENSIONS, HEADER_BYTES,
} = require('../lib/filetype');
const { scratch, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

const FIXTURES = path.join(__dirname, 'fixtures');

// A WebP file made of these chunks, each [fourcc, length], with zero payloads
function webp(chunks) {
    const parts = [];
    for (const [fourcc, length] of chunks) {
        const head = Buffer.alloc(8);
        head.write(fourcc, 0, 'latin1');
        head.writeUInt32LE(length, 4);
        parts.push(head, Buffer.alloc(length + (length & 1)));
    }
    const body = Buffer.concat(parts);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(body.length + 4, 4);
    riff.write('WEBP', 8, 'latin1');
    return Buffer.concat([riff, body]);
}

function writeTemp(name, bytes) {
    const file = path.join(scratch(), name);
    fs.writeFileSync(file, bytes);
    return file;
}

// An ISO BMFF file starting with an 'ftyp' box of these brands
function ftyp(major, ...compatible) {
    const box = Buffer.alloc(16 + 4 * compatible.length);
    box.writeUInt32BE(box.length, 0);
    box.write('ftyp', 4, 'latin1');
    box.write(major, 8, 'latin1');
    compatible.forEach((brand, i) => box.write(brand, 16 + 4 * i, 'latin1'));
    return Buffer.concat([box, Buffer.alloc(32)]);
}

test('WebP is told by RIFF....WEBP', () => {
    assert.strictEqual(detectType(webp([['VP8 ', 10]]), 'x.bin'), 'webp');
    const wave = Buffer.from(webp([['VP8 ', 10]]));
    wave.write('WAVE', 8, 'latin1');
    assert.strictEqual(detectType(wave, 'x.wav'), null, 'another RIFF format is not WebP');
});

test('AVIF is told by its brands, whichever comes first', () => {
    assert.strictEqual(detectType(ftyp('avif', 'mif1', 'miaf'), 'a'), 'avif');
    assert.strictEqual(detectType(ftyp('avis', 'avif', 'msf1'), 'a'), 'avif');
    assert.strictEqual(detectType(ftyp('mif1', 'miaf', 'avif'), 'a'), 'avif', 'a compatible brand counts');
    assert.strictEqual(detectType(ftyp('heic', 'mif1', 'heix'), 'a.heic'), null, 'HEIC shares the box, not the brand');
});

test('the header read for detection is long enough for an ftyp box', () => {
    // libavif writes 28 to 44 bytes; the brands past the end would be missed
    assert.ok(HEADER_BYTES >= 48);
});

test('a lossless WebP with metadata, from its chunks', () => {
    const file = writeTemp('meta.webp', webp([['VP8X', 10], ['ICCP', 595], ['VP8L', 100], ['EXIF', 30], ['XMP ', 41]]));
    assert.deepStrictEqual(inspectWebP(file),
        { lossless: true, lossy: false, animated: false, exif: true, xmp: true, icc: true });
});

test('a lossy WebP with alpha, and an animation', () => {
    const lossy = writeTemp('alpha.webp', webp([['VP8X', 10], ['ALPH', 7], ['VP8 ', 64]]));
    assert.strictEqual(inspectWebP(lossy).lossy, true);
    assert.strictEqual(inspectWebP(lossy).lossless, false);
    const anim = writeTemp('anim.webp', webp([['VP8X', 10], ['ANIM', 6], ['ANMF', 40], ['ANMF', 40]]));
    assert.strictEqual(inspectWebP(anim).animated, true);
});

test('a truncated or foreign file is not a WebP', () => {
    assert.strictEqual(inspectWebP(writeTemp('cut.webp', webp([['VP8X', 10]]))), null, 'no image chunk');
    const whole = webp([['VP8 ', 400]]);
    assert.strictEqual(inspectWebP(writeTemp('short.webp', whole.subarray(0, 40))), null, 'image chunk cut short');
    assert.strictEqual(inspectWebP(path.join(scratch(), 'missing.webp')), null);
});

test('the real fixtures are read as what they are', () => {
    const lossless = inspectWebP(path.join(FIXTURES, 'lossless-metadata.webp'));
    assert.deepStrictEqual(lossless, { lossless: true, lossy: false, animated: false, exif: true, xmp: true, icc: true });
    const lossy = inspectWebP(path.join(FIXTURES, 'lossy.webp'));
    assert.strictEqual(lossy.lossy, true);
    assert.strictEqual(lossy.exif || lossy.xmp, false);

    const header = fs.readFileSync(path.join(FIXTURES, 'photo.avif')).subarray(0, HEADER_BYTES);
    assert.strictEqual(detectType(header, 'photo.avif'), 'avif');
    assert.deepStrictEqual(inspectAvif(header), { animated: false, gainMap: false });
});

test('an AVIF sequence and a gain map are recognised by brand', () => {
    assert.deepStrictEqual(inspectAvif(ftyp('avis', 'avif', 'msf1')), { animated: true, gainMap: false });
    assert.deepStrictEqual(inspectAvif(ftyp('avif', 'mif1', 'miaf', 'MA1A', 'tmap')), { animated: false, gainMap: true });
});

test('.webp and .avif are scanned, in any case', () => {
    assert.ok(EXTENSIONS.includes('.webp') && EXTENSIONS.includes('.avif'));
    assert.strictEqual(typeFromExtension('C:\\a\\Photo.WEBP'), 'webp');
    assert.strictEqual(typeFromExtension('b.avif'), 'avif');
});
