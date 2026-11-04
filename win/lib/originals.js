'use strict';

// Settings → Options → Keep originals: before a file is first overwritten, its
// untouched bytes are copied into an "ImageOptim originals" folder beside it.
// Nothing in such a folder is ever optimized, and nothing there is deleted
// except by Revert, which moves the copy back to where it came from.

const fs = require('fs');
const path = require('path');

const ORIGINALS_DIR = 'ImageOptim originals';

// NTFS names are case-insensitive, so match the folder that way everywhere
function isOriginalsDir(name) {
    return String(name).toLowerCase() === ORIGINALS_DIR.toLowerCase();
}

function isInOriginals(filePath) {
    return path.dirname(path.resolve(filePath)).split(/[\\/]/).some(isOriginalsDir);
}

function sameContent(a, b) {
    try {
        if (fs.statSync(a).size !== fs.statSync(b).size) return false;
        return fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch (err) {
        return false;
    }
}

// Copies `file` into the folder and returns { path, created }. An identical
// copy already there (an earlier session kept it) is reused rather than
// duplicated; a different file of the same name gets "name (2).png" and so on.
// Throws if the copy cannot be made, so the caller never overwrites a file
// whose original was not kept.
function keepOriginal(file, { atime, mtime } = {}) {
    const dir = path.join(path.dirname(file), ORIGINALS_DIR);
    // Throws, among other things, if a *file* of that name is in the way
    fs.mkdirSync(dir, { recursive: true });

    const ext = path.extname(file);
    const base = path.basename(file, ext);
    for (let n = 1; n <= 999; n++) {
        const candidate = path.join(dir, n === 1 ? `${base}${ext}` : `${base} (${n})${ext}`);
        if (fs.existsSync(candidate)) {
            if (sameContent(candidate, file)) return { path: candidate, created: false };
            continue;
        }
        try {
            fs.copyFileSync(file, candidate, fs.constants.COPYFILE_EXCL);
        } catch (err) {
            if (err.code === 'EEXIST') continue; // taken between the check and the copy
            throw err;
        }
        // The copy carries the original's dates, so it sorts and reads as the
        // file it was
        if (atime && mtime) {
            try { fs.utimesSync(candidate, atime, mtime); } catch (err) { /* best effort */ }
        }
        return { path: candidate, created: true };
    }
    throw new Error(`there are too many files named ${base}${ext} in ${ORIGINALS_DIR}`);
}

// After Revert has moved the last copy back
function removeIfEmpty(dir) {
    try {
        if (isOriginalsDir(path.basename(dir)) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch (err) {
        /* not empty, or not ours to remove */
    }
}

module.exports = { ORIGINALS_DIR, isOriginalsDir, isInOriginals, keepOriginal, removeIfEmpty };
