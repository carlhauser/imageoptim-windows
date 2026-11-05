'use strict';

// Which command-line arguments are files to optimize (lib/argv.js). A mistake
// here once had the app optimize, and overwrite, every image in its own
// checkout.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { filePathsFromArgv } = require('../lib/argv');
const { scratch, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

function folder(name) {
    const dir = path.join(scratch(), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.png'), 'x');
    return dir;
}

test('files and folders that exist, resolved against the folder given', () => {
    const dir = folder('argv-cwd');
    const exe = 'C:\\Program Files\\ImageOptim\\ImageOptim.exe';
    assert.deepStrictEqual(filePathsFromArgv([exe, 'a.png', 'missing.png'], dir), [path.join(dir, 'a.png')]);
    assert.deepStrictEqual(filePathsFromArgv([exe, dir], scratch()), [dir]);
});

test('switches and the bare dot are never files', () => {
    const dir = folder('argv-switches');
    const argv = ['electron.exe', '--user-data-dir=x', '--remote-debugging-port=9222', '.', 'a.png'];
    assert.deepStrictEqual(filePathsFromArgv(argv, dir), [path.join(dir, 'a.png')]);
});

test('the app\'s own folder, wherever it appears, in any case', () => {
    const app = folder('argv-app');
    const argv = ['electron.exe', '--flag', app.toUpperCase(), path.join(app, 'a.png')];
    assert.deepStrictEqual(filePathsFromArgv(argv, scratch(), { appDir: app }),
        [path.join(app, 'a.png')], 'the checkout itself is dropped, a file in it is not');
});

test('a relative path from a second instance resolves against its own folder', () => {
    const theirs = folder('argv-theirs');
    folder('argv-ours');
    assert.deepStrictEqual(filePathsFromArgv(['x.exe', 'a.png'], theirs), [path.join(theirs, 'a.png')]);
});
