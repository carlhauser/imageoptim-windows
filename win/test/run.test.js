'use strict';

// Starting an optimizer (lib/run.js). Node itself stands in for the tool.

const test = require('node:test');
const assert = require('node:assert');
const run = require('../lib/run');

const node = (script) => ({ exe: process.execPath, args: ['-e', script] });

test('optimizers run below normal priority, so the PC stays usable', async () => {
    // The child reports its own priority once the parent has had time to set it
    const { code, output } = await run.runTool(node(
        "setTimeout(() => console.log(require('os').getPriority()), 300)"));
    assert.strictEqual(code, 0);
    assert.strictEqual(Number(output.trim()), run.PRIORITY);
});

test('Stop kills the process', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = run.runTool({ ...node('setTimeout(() => {}, 30000)'), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const { code } = await pending;
    assert.notStrictEqual(code, 0);
    assert.ok(Date.now() - started < 10000);
});

test('the output kept is capped, however much a tool prints', async () => {
    const { output } = await run.runTool(node("process.stdout.write('x'.repeat(1 << 20))"));
    assert.ok(output.length < 200 * 1024, String(output.length));
});

test('a program that cannot be started rejects, and leaves no descriptor open', async () => {
    await assert.rejects(run.runTool({ exe: 'C:\no\such\tool.exe', args: [] }));
});

test('numberAfter and firstTwoNumbers read what jpegoptim and advpng print', () => {
    assert.strictEqual(run.numberAfter('a.jpg 100x100 24bit [OK] 2000 --> 1500 bytes', ' --> '), 1500);
    assert.strictEqual(run.numberAfter('nothing here', ' --> '), 0);
    assert.deepStrictEqual(run.firstTwoNumbers('        2398        2003  83% x.png'), [2398, 2003]);
    assert.strictEqual(run.firstTwoNumbers('no numbers'), null);
});
