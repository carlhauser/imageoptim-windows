'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { expandPaths, Queue } = require('../lib/queue');
const { Settings } = require('../lib/settings');
const { scratch, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

function tree(name, build) {
    const root = path.join(scratch(), name);
    fs.mkdirSync(root, { recursive: true });
    build(root);
    return root;
}

test('expandPaths — picks up only supported extensions', async () => {
    const root = tree('ext', (r) => {
        for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.svg', 'f.txt', 'g.psd', 'h']) {
            fs.writeFileSync(path.join(r, f), 'x');
        }
    });
    const found = (await expandPaths([root])).map((p) => path.basename(p)).sort();
    assert.deepStrictEqual(found, ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.svg']);
});

test('expandPaths — descends, and skips dot files', async () => {
    const root = tree('deep', (r) => {
        fs.mkdirSync(path.join(r, 'sub', 'deeper'), { recursive: true });
        fs.writeFileSync(path.join(r, 'top.png'), 'x');
        fs.writeFileSync(path.join(r, 'sub', 'mid.png'), 'x');
        fs.writeFileSync(path.join(r, 'sub', 'deeper', 'low.png'), 'x');
        fs.mkdirSync(path.join(r, '.hidden'));
        fs.writeFileSync(path.join(r, '.hidden', 'secret.png'), 'x');
        fs.writeFileSync(path.join(r, '.dotted.png'), 'x');
    });
    const found = (await expandPaths([root])).map((p) => path.basename(p)).sort();
    assert.deepStrictEqual(found, ['low.png', 'mid.png', 'top.png']);
});

test('expandPaths — the same file given twice is queued once', async () => {
    const root = tree('dupe', (r) => fs.writeFileSync(path.join(r, 'one.png'), 'x'));
    const file = path.join(root, 'one.png');
    assert.strictEqual((await expandPaths([file, file, root])).length, 1);
});

test('expandPaths — a directory cycle terminates', async () => {
    // A symlink resolving to an ancestor used to be followed forever: the loop
    // contains no new images, so the file-count cap never ended it either.
    const root = tree('cycle', (r) => {
        fs.mkdirSync(path.join(r, 'inner'));
        fs.writeFileSync(path.join(r, 'only.png'), 'x');
        // A junction on Windows: a true symlink needs administrator rights or
        // Developer Mode there, and junctions are also how a cycle most often
        // turns up on a Windows disk. The type is ignored on other platforms.
        fs.symlinkSync(r, path.join(r, 'inner', 'loop'), 'junction');
    });
    let guard;
    const found = await Promise.race([
        expandPaths([root]),
        new Promise((_, reject) => {
            guard = setTimeout(() => reject(new Error('expandPaths did not terminate')), 10000);
        }),
    ]).finally(() => clearTimeout(guard));
    assert.deepStrictEqual(found.map((p) => path.basename(p)), ['only.png']);
});

function queueWith(order, sizes) {
    const settingsFile = path.join(scratch(), `q-${Math.random().toString(16).slice(2)}.json`);
    const settings = new Settings(settingsFile);
    settings.reset();
    settings.update({ QueueOrder: order });
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.pending = sizes.map((size, i) => ({ originalSize: size, name: `f${i}` }));
    queue.sortPending();
    return queue.pending.map((j) => j.originalSize);
}

test('queue order — smallest first', () => {
    assert.deepStrictEqual(queueWith('smallest', [500, 100, 900, 300]), [100, 300, 500, 900]);
});

test('queue order — largest first', () => {
    assert.deepStrictEqual(queueWith('largest', [500, 100, 900, 300]), [900, 500, 300, 100]);
});

test('queue order — added keeps drop order', () => {
    assert.deepStrictEqual(queueWith('added', [500, 100, 900, 300]), [500, 100, 900, 300]);
});

test('adding the same folder twice does not queue a file twice', async () => {
    const root = tree('twice', (r) => {
        fs.writeFileSync(path.join(r, 'a.png'), 'x'.repeat(100));
        fs.writeFileSync(path.join(r, 'b.png'), 'x'.repeat(100));
    });
    const settings = new Settings(path.join(scratch(), 'twice.json'));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.start = () => {}; // do not actually run anything
    await queue.add([root]);
    await queue.add([root]);
    assert.strictEqual(queue.jobs.size, 2, 'two distinct files');
    assert.strictEqual(queue.pending.length, 2, 'and each queued once');
});

test('again() does not queue a job that is already pending', async () => {
    const root = tree('again', (r) => fs.writeFileSync(path.join(r, 'a.png'), 'x'.repeat(100)));
    const settings = new Settings(path.join(scratch(), 'again.json'));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.start = () => {};
    await queue.add([root]);
    queue.again();
    assert.strictEqual(queue.pending.length, 1);
});

test('stats() reports the batch, its time left and each row\'s progress', async () => {
    const { Job } = require('../lib/job');
    const root = tree('batch', (r) => {
        for (const name of ['a.svg', 'b.svg', 'c.svg']) fs.writeFileSync(path.join(r, name), '<svg/>'.repeat(20));
    });
    const settings = new Settings(path.join(scratch(), 'batch.json'));
    settings.reset();
    settings.update({ MaxWorkers: 1 });
    const clock = { t: 0 };
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin'), now: () => clock.t });

    // Each run waits until the test finishes it
    const finishers = [];
    const realRun = Job.prototype.run;
    Job.prototype.run = function run() {
        this.setState('running');
        return new Promise((resolve) => finishers.push(() => {
            this.toolsTotal = 1;
            this.costClassName = this.costClass(settings.all());
            this.costBytes = this.originalSize;
            this.setState('done');
            resolve();
        }));
    };
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    try {
        await queue.add([root]);
        let batch = queue.stats().batch;
        assert.strictEqual(batch.total, 3);
        assert.strictEqual(batch.done, 0);
        assert.strictEqual(batch.estimating, true);
        assert.strictEqual(batch.text, '0 of 3 done · estimating time left…');

        clock.t += 2000;
        finishers.shift()();
        await settle();
        batch = queue.stats().batch;
        assert.strictEqual(batch.done, 1);
        assert.strictEqual(batch.estimating, false);
        assert.strictEqual(batch.remainingMs, 4000, 'two more of 2 s each, one at a time');

        // The running row's line follows the clock
        clock.t += 1000;
        const [running] = queue.runningJobs();
        assert.ok(Math.abs(running.toJSON().progress - 0.5) < 1e-9);

        finishers.shift()();
        await settle();
        finishers.shift()();
        await settle();
        assert.strictEqual(queue.stats().batch, null, 'no batch once the queue is empty');
        assert.strictEqual(queue.isBusy(), false);
    } finally {
        Job.prototype.run = realRun;
    }
});
