'use strict';

// The app's log (lib/log.js) records what went wrong, never where anyone's
// files are.

const test = require('node:test');
const assert = require('node:assert');
const { scrub } = require('../lib/log');

test('paths are taken out of what is logged', () => {
    assert.strictEqual(
        scrub("EBUSY: resource busy or locked, open 'C:\\Users\\someone\\Pictures\\Holiday\\beach.png'"),
        "EBUSY: resource busy or locked, open '<path>'");
    assert.strictEqual(scrub('can\'t open \\\\server\\share\\photo.jpg for reading'), 'can\'t open <path>');
    assert.strictEqual(scrub('D:/Photos/x.png failed'), '<path>');
    assert.strictEqual(scrub('jpegtran exited 1 after 30 ms'), 'jpegtran exited 1 after 30 ms');
    assert.strictEqual(scrub(42), 42);
});

test('an error is logged as its stack, scrubbed', () => {
    const err = new Error("ENOENT: no such file, open 'C:\\secret\\name.png'");
    assert.ok(!/secret/.test(scrub(err)));
});
