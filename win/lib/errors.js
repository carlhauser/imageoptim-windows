'use strict';

// What went wrong with a file, in words for the list, from Node's error codes.
// "EBUSY: resource busy or locked, open 'C:\…'" says nothing to most people;
// what they need is the reason and what to do about it.

const PLAIN = {
    EBUSY: 'In use by another program. Close it and optimize again.',
    EPERM: 'In use by another program, or not allowed to be changed. Close it and optimize again.',
    EACCES: 'Not allowed to be changed: the file or its folder is read-only or protected.',
    EROFS: 'On a drive that cannot be written to.',
    ENOSPC: 'The disk is full.',
    ENOENT: 'The file is no longer there.',
    EISDIR: 'That is a folder, not a file.',
    ENAMETOOLONG: 'Its path is too long.',
    EIO: 'The drive reported an error.',
};

function describeFsError(err) {
    if (err && PLAIN[err.code]) return PLAIN[err.code];
    return (err && err.message) || String(err);
}

module.exports = { describeFsError };
