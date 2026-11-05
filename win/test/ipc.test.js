'use strict';

// The window and the main process agree on their channel names. A typo on
// either side is no error until the call is made, and then only in the
// window's console.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const all = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

const preload = read('preload.js');
const main = read('main.js');

test('every channel the window invokes has a handler', () => {
    const invoked = new Set(all(preload, /ipcRenderer\.invoke\('([^']+)'/g));
    const handled = new Set(all(main, /\bhandle\('([^']+)'/g));
    assert.ok(invoked.size > 10, 'found the invokes');
    for (const channel of invoked) assert.ok(handled.has(channel), `no handler for ${channel}`);
    for (const channel of handled) assert.ok(invoked.has(channel), `${channel} is handled but never invoked`);
});

test('every channel the window listens on is sent by the main process', () => {
    const listened = new Set(all(preload, /ipcRenderer\.on\('([^']+)'/g));
    const sent = new Set(all(main, /\bsend\('([^']+)'/g));
    for (const channel of listened) assert.ok(sent.has(channel), `nothing sends ${channel}`);
});

test('the handlers only answer the app\'s own page', () => {
    assert.doesNotMatch(main.replace(/function handle\([\s\S]*?\n}\n/, ''), /ipcMain\.handle\(/,
        'every handler goes through handle(), which checks the sender');
});
