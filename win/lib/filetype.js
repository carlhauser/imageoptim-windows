'use strict';

const fs = require('fs');

// Port of imageoptim/Backend/File.m: sniff the format from the file header and
// classify the file as small or large, which several optimizers use to pick
// cheaper settings. WebP and AVIF are additions of this port; the macOS app
// handles neither.

const PNG = 'png';
const JPEG = 'jpeg';
const GIF = 'gif';
const SVG = 'svg';
const WEBP = 'webp';
const AVIF = 'avif';

// How many leading bytes detectType needs to see. An AVIF file names its
// brands in its first box, which is usually 28 to 44 bytes long.
const HEADER_BYTES = 64;

const HEADERS = [
    [PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])],
    [JPEG, Buffer.from([0xff, 0xd8, 0xff])],
    [GIF, Buffer.from([0x47, 0x49, 0x46, 0x38])],
    [SVG, Buffer.from('<svg')],
];

// The brands an ISO BMFF file lists in its leading 'ftyp' box: the major brand
// first, then the compatible ones. Empty when the file is not BMFF, and cut
// short at the end of the buffer.
function bmffBrands(buffer) {
    if (buffer.length < 16 || buffer.toString('latin1', 4, 8) !== 'ftyp') return [];
    const boxSize = buffer.readUInt32BE(0);
    const end = Math.min(buffer.length, boxSize >= 16 ? boxSize : buffer.length);
    const brands = [buffer.toString('latin1', 8, 12)];
    for (let at = 16; at + 4 <= end; at += 4) brands.push(buffer.toString('latin1', at, at + 4));
    return brands;
}

function detectType(buffer, filePath) {
    if (!buffer || buffer.length < 6) {
        return null;
    }

    for (const [type, magic] of HEADERS) {
        if (buffer.subarray(0, magic.length).equals(magic)) {
            return type;
        }
    }

    if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF'
        && buffer.toString('latin1', 8, 12) === 'WEBP') {
        return WEBP;
    }

    // HEIC shares the container, so only the AVIF brands count
    const brands = bmffBrands(buffer);
    if (brands.includes('avif') || brands.includes('avis')) {
        return AVIF;
    }

    // SVG files often start with an XML declaration or a comment rather than <svg>
    if (/\.svg$/i.test(filePath || '')) {
        return SVG;
    }
    return null;
}

// What a WebP file holds, from its chunk list: whether it is lossless (VP8L)
// or lossy (VP8 ), animated, and which metadata chunks it carries. Only the
// eight-byte chunk headers are read, so this is cheap whatever the file size.
// Returns null for a file that is not a well-formed WebP.
function inspectWebP(filePath) {
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const size = fs.fstatSync(fd).size;
        const head = Buffer.alloc(8);
        const info = { lossless: false, lossy: false, animated: false, exif: false, xmp: false, icc: false };

        let at = 12; // after RIFF <size> WEBP
        while (at + 8 <= size) {
            if (fs.readSync(fd, head, 0, 8, at) < 8) break;
            const fourcc = head.toString('latin1', 0, 4);
            const length = head.readUInt32LE(4);
            // A chunk running past the end: the file was cut short
            if (at + 8 + length > size) return null;
            if (fourcc === 'VP8L') info.lossless = true;
            else if (fourcc === 'VP8 ') info.lossy = true;
            else if (fourcc === 'ANIM' || fourcc === 'ANMF') info.animated = true;
            else if (fourcc === 'EXIF') info.exif = true;
            else if (fourcc === 'XMP ') info.xmp = true;
            else if (fourcc === 'ICCP') info.icc = true;
            at += 8 + length + (length & 1); // chunks are padded to an even length
        }

        return info.lossless || info.lossy || info.animated ? info : null;
    } catch (err) {
        return null;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (err) { /* already closed */ }
        }
    }
}

// What an AVIF file's brands say about it. A sequence ('avis') is animated,
// and 'tmap' marks a gain map, which lets the image adapt to an HDR display.
// avifdec writes out only the first frame and the base image, so re-encoding
// either kind would lose the rest.
function inspectAvif(buffer) {
    const brands = bmffBrands(buffer);
    return {
        animated: brands.includes('avis'),
        gainMap: brands.includes('tmap'),
    };
}

// Format-specific facts the plan depends on, read once per run. null for the
// formats that need none.
function inspect(type, filePath, header) {
    if (type === WEBP) return inspectWebP(filePath);
    if (type === AVIF) return inspectAvif(header);
    return null;
}

function isLarge(type, byteSize) {
    return type === PNG ? byteSize > 250 * 1024 : byteSize > 1024 * 1024;
}

function isSmall(type, byteSize) {
    return type === PNG ? byteSize < 2048 : byteSize < 10 * 1024;
}

const BY_EXTENSION = {
    '.png': PNG, '.jpg': JPEG, '.jpeg': JPEG, '.gif': GIF, '.svg': SVG,
    '.webp': WEBP, '.avif': AVIF,
};

const EXTENSIONS = Object.keys(BY_EXTENSION);

// What a file probably is before its header has been read: for estimating how
// long a queued file will take, never for choosing optimizers.
function typeFromExtension(filePath) {
    const match = /\.[^.\\/]+$/.exec(filePath || '');
    return (match && BY_EXTENSION[match[0].toLowerCase()]) || null;
}

module.exports = {
    PNG, JPEG, GIF, SVG, WEBP, AVIF,
    HEADER_BYTES,
    detectType, inspect, inspectWebP, inspectAvif, typeFromExtension, isLarge, isSmall, EXTENSIONS,
};
