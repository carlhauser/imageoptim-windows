'use strict';

// The shared limit on optimizer processes (lib/semaphore.js)

const test = require('node:test');
const assert = require('node:assert');
const { Semaphore } = require('../lib/semaphore');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('hands out slots up to the limit, then in arrival order', async () => {
    const s = new Semaphore(2);
    assert.strictEqual(await s.acquire(), true);
    assert.strictEqual(await s.acquire(), true);
    const order = [];
    const third = s.acquire().then(() => order.push('third'));
    const fourth = s.acquire().then(() => order.push('fourth'));
    await settle();
    assert.deepStrictEqual(order, []);
    s.release();
    await third;
    s.release();
    await fourth;
    assert.deepStrictEqual(order, ['third', 'fourth']);
    assert.strictEqual(s.active, 2);
});

test('a waiter whose file is stopped leaves the line and takes no slot', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const controller = new AbortController();
    const waiting = s.acquire(controller.signal);
    assert.strictEqual(s.waiting.length, 1);
    controller.abort();
    assert.strictEqual(await waiting, false);
    assert.strictEqual(s.waiting.length, 0);
    s.release();
    assert.strictEqual(s.active, 0, 'the slot was not handed to the stopped waiter');
});

test('run() skips the work entirely when stopped before its turn', async () => {
    const s = new Semaphore(1);
    await s.acquire();
    const controller = new AbortController();
    let ran = false;
    const pending = s.run(() => { ran = true; }, controller.signal);
    controller.abort();
    assert.strictEqual(await pending, null);
    assert.strictEqual(ran, false);
    assert.strictEqual(await s.run(() => 'already aborted', controller.signal), null);
});

test('run() releases its slot even when the work throws', async () => {
    const s = new Semaphore(1);
    await assert.rejects(s.run(async () => { throw new Error('boom'); }));
    assert.strictEqual(s.active, 0);
});

test('threadsPerSlot — cores shared by the slots in use, or by all of them while others wait', async () => {
    const s = new Semaphore(4);
    assert.strictEqual(s.threadsPerSlot(16), 16, 'nothing running: all of them');
    await s.acquire();
    assert.strictEqual(s.threadsPerSlot(16), 16, 'alone');
    await s.acquire();
    assert.strictEqual(s.threadsPerSlot(16), 8);
    await s.acquire();
    await s.acquire();
    s.acquire(); // a fifth, waiting
    assert.strictEqual(s.threadsPerSlot(16), 4, 'full, and more to come');
    assert.strictEqual(new Semaphore(8).threadsPerSlot(2), 2);
    const crowded = new Semaphore(8);
    for (let i = 0; i < 8; i++) await crowded.acquire();
    assert.strictEqual(crowded.threadsPerSlot(4), 1, 'never below one');
});
