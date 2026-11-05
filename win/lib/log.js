'use strict';

// The app's own log, userData\logs\main.log, for when an optimizer misbehaves
// or the app itself fails: in the packaged app console output goes nowhere,
// and a broken tool looked exactly like an already-optimal file.
//
// It records what happened and to which tool, never to which file: anything
// that looks like a path is replaced before it is written, as the list of
// optimized files records nothing about where anyone's files are either.
//
// Until open() is called - in the tests - messages go to the console.

const fs = require('fs');
const path = require('path');
const { makeFileLogger } = require('./updater');

let logger = null;
let logDir = null;

// Drive paths and network paths, up to a quote or the end of the line
const PATHS = /(?:[A-Za-z]:[\\/]|\\\\)[^'"\r\n]*/g;

function scrub(value) {
    if (value instanceof Error) return scrub(value.stack || value.message);
    if (typeof value !== 'string') return value;
    return value.replace(PATHS, '<path>');
}

function open(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        logDir = dir;
        logger = makeFileLogger(path.join(dir, 'main.log'), { maxBytes: 1024 * 1024 });
    } catch (err) {
        logger = null;
    }
}

function write(level, args) {
    const clean = args.map(scrub);
    if (logger) logger[level](...clean);
    else if (level !== 'info') console.warn(...clean);
}

module.exports = {
    open,
    scrub,
    dir: () => logDir,
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
};
