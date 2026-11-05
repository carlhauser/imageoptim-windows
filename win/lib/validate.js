'use strict';

// A last look at an optimizer's output before it may replace anyone's file.
//
// A tool is trusted when it exits 0 and its file is smaller. Smaller is also
// what a truncated file is, and a tool can exit 0 with one: a full disk, an
// unchecked fwrite, a decoder bug. These checks are structural and cheap - the
// head and the tail of the file, never a decode - and each looks for the part
// of its format that only a complete file has.

const fs = require('fs');
const { PNG, JPEG, GIF, SVG, WEBP, AVIF } = require('./filetype');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The IEND chunk is always these twelve bytes: length 0, type, fixed CRC
const PNG_IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function readAt(fd, position, length) {
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, read);
}

function png(fd, size) {
    if (size < PNG_SIGNATURE.length + 25 + PNG_IEND.length) return false;
    const head = readAt(fd, 0, 16);
    return head.subarray(0, 8).equals(PNG_SIGNATURE)
        && head.toString('latin1', 12, 16) === 'IHDR'
        && readAt(fd, size - PNG_IEND.length, PNG_IEND.length).equals(PNG_IEND);
}

function jpeg(fd, size) {
    if (size < 4) return false;
    const head = readAt(fd, 0, 3);
    const tail = readAt(fd, size - 2, 2);
    return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
        && tail[0] === 0xff && tail[1] === 0xd9;
}

function gif(fd, size) {
    if (size < 14) return false;
    return readAt(fd, 0, 4).toString('latin1') === 'GIF8' && readAt(fd, size - 1, 1)[0] === 0x3b;
}

// RIFF's own length field: the whole file but the first eight bytes
function webp(fd, size) {
    if (size < 20) return false;
    const head = readAt(fd, 0, 12);
    return head.toString('latin1', 0, 4) === 'RIFF'
        && head.toString('latin1', 8, 12) === 'WEBP'
        && head.readUInt32LE(4) + 8 === size;
}

// ISO-BMFF: top-level boxes laid end to end must add up to the file exactly,
// so a file cut short anywhere leaves its last box hanging past the end.
function avif(fd, size) {
    let offset = 0;
    let boxes = 0;
    while (offset < size) {
        const header = readAt(fd, offset, 16);
        if (header.length < 8) return false;
        let length = header.readUInt32BE(0);
        const type = header.toString('latin1', 4, 8);
        if (boxes === 0 && type !== 'ftyp') return false;
        if (length === 1) {
            if (header.length < 16) return false;
            length = Number(header.readBigUInt64BE(8));
        } else if (length === 0) {
            length = size - offset; // to the end of the file
        }
        if (length < 8 || offset + length > size) return false;
        offset += length;
        boxes += 1;
        if (boxes > 10000) return false;
    }
    return boxes >= 2; // ftyp alone holds no image
}

// SVG is text: an opening <svg, and nothing after the root element closes
function svg(fd, size) {
    if (size < 6) return false;
    const head = readAt(fd, 0, Math.min(size, 64 * 1024)).toString('utf8');
    if (!/<svg[\s>/]/i.test(head)) return false;
    const tail = readAt(fd, Math.max(0, size - 256), Math.min(size, 256)).toString('utf8');
    if (/<\/svg\s*>\s*$/i.test(tail)) return true;
    // An empty image can be a single self-closed <svg ... />
    return size <= 64 * 1024 && /<svg\b[^>]*\/>\s*$/i.test(head);
}

const CHECKS = { [PNG]: png, [JPEG]: jpeg, [GIF]: gif, [WEBP]: webp, [AVIF]: avif, [SVG]: svg };

// True when the file at filePath looks like a whole image of this type. A
// type with no check passes, and so does nothing else: an unreadable file
// fails.
function looksComplete(type, filePath) {
    const check = CHECKS[type];
    if (!check) return true;
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const { size } = fs.fstatSync(fd);
        return Boolean(size) && check(fd, size);
    } catch (err) {
        return false;
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch (err) { /* already closed */ }
        }
    }
}

// Room for a file of `bytes` in the folder `dir`, keeping some slack: what is
// written there must fit beside what is already being written. Unknown is
// not "full" - a volume that will not say is given the benefit of the doubt.
function hasRoomFor(dir, bytes, slack = 8 * 1024 * 1024) {
    try {
        const stats = fs.statfsSync(dir);
        return Number(stats.bavail) * Number(stats.bsize) >= bytes + slack;
    } catch (err) {
        return true;
    }
}

module.exports = { looksComplete, hasRoomFor };
