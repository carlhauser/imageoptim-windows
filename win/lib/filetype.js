'use strict';

// Port of imageoptim/Backend/File.m: sniff the format from the file header and
// classify the file as small or large, which several optimizers use to pick
// cheaper settings.

const PNG = 'png';
const JPEG = 'jpeg';
const GIF = 'gif';
const SVG = 'svg';

const HEADERS = [
    [PNG, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])],
    [JPEG, Buffer.from([0xff, 0xd8, 0xff])],
    [GIF, Buffer.from([0x47, 0x49, 0x46, 0x38])],
    [SVG, Buffer.from('<svg')],
];

function detectType(buffer, filePath) {
    if (!buffer || buffer.length < 6) {
        return null;
    }

    for (const [type, magic] of HEADERS) {
        if (buffer.subarray(0, magic.length).equals(magic)) {
            return type;
        }
    }

    // SVG files often start with an XML declaration or a comment rather than <svg>
    if (/\.svg$/i.test(filePath || '')) {
        return SVG;
    }
    return null;
}

function isLarge(type, byteSize) {
    return type === PNG ? byteSize > 250 * 1024 : byteSize > 1024 * 1024;
}

function isSmall(type, byteSize) {
    return type === PNG ? byteSize < 2048 : byteSize < 10 * 1024;
}

const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg'];

module.exports = { PNG, JPEG, GIF, SVG, detectType, isLarge, isSmall, EXTENSIONS };
