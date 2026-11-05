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
        for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.svg', 'f.txt', 'g.psd', 'h', 'i.webp', 'j.AVIF', 'k.heic']) {
            fs.writeFileSync(path.join(r, f), 'x');
        }
    });
    const found = (await expandPaths([root])).map((p) => path.basename(p)).sort();
    assert.deepStrictEqual(found, ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.svg', 'i.webp', 'j.AVIF']);
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

// ------------------------------------------------ removing what is running

// A queue whose jobs wait in run() until the test lets them finish
function heldQueue(name) {
    const { Job } = require('../lib/job');
    const settings = new Settings(path.join(scratch(), `${name}.json`));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    const finishers = [];
    const realRun = Job.prototype.run;
    Job.prototype.run = function run() {
        this.isRunning = true;
        this.setState('running');
        return new Promise((resolve) => finishers.push(() => {
            this.isRunning = false;
            this.setState('done');
            resolve();
        }));
    };
    const restore = () => { Job.prototype.run = realRun; };
    return { queue, finishers, restore };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a running job taken out of the list sends nothing more, and is cleaned up once it stops', async () => {
    const root = tree('ghost', (r) => fs.writeFileSync(path.join(r, 'a.svg'), '<svg/>'.repeat(20)));
    const { queue, finishers, restore } = heldQueue('ghost');
    try {
        await queue.add([root]);
        const [job] = queue.jobs.values();
        const backup = path.join(scratch(), 'ghost-backup.temp');
        fs.writeFileSync(backup, 'backup');
        job.backupPath = backup;

        const events = [];
        queue.on('job', (snapshot) => events.push(snapshot));
        queue.remove([job.id]);
        assert.ok(fs.existsSync(backup), 'not deleted while the job still runs');

        finishers.shift()();
        await settle();
        assert.deepStrictEqual(events, [], 'no event to bring the row back');
        assert.ok(!fs.existsSync(backup), 'cleaned up once it settled');
        assert.strictEqual(queue.running, 0);
    } finally {
        restore();
    }
});

test('clear defers a running job\'s cleanup the same way', async () => {
    const root = tree('clear-run', (r) => fs.writeFileSync(path.join(r, 'a.svg'), '<svg/>'.repeat(20)));
    const { queue, finishers, restore } = heldQueue('clear-run');
    try {
        await queue.add([root]);
        const [job] = queue.jobs.values();
        const backup = path.join(scratch(), 'clear-backup.temp');
        fs.writeFileSync(backup, 'backup');
        job.backupPath = backup;
        queue.clear();
        assert.strictEqual(queue.jobs.size, 0);
        assert.ok(fs.existsSync(backup));
        finishers.shift()();
        await settle();
        assert.ok(!fs.existsSync(backup));
    } finally {
        restore();
    }
});

test('revert is refused while a file is being optimized', async () => {
    const root = tree('revert-run', (r) => fs.writeFileSync(path.join(r, 'a.svg'), '<svg/>'.repeat(20)));
    const { queue, finishers, restore } = heldQueue('revert-run');
    try {
        await queue.add([root]);
        const [job] = queue.jobs.values();
        const result = queue.revert(job.id);
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /being optimized/);
        finishers.shift()();
        await settle();
    } finally {
        restore();
    }
});

test('one file under two spellings is one job', { skip: process.platform !== 'win32' && 'NTFS only' }, async () => {
    const root = tree('spelling', (r) => fs.writeFileSync(path.join(r, 'Photo.png'), 'x'.repeat(100)));
    const settings = new Settings(path.join(scratch(), 'spelling.json'));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.start = () => {};
    await queue.add([path.join(root, 'Photo.png')]);
    await queue.add([path.join(root.toUpperCase(), 'PHOTO.PNG')]);
    assert.strictEqual(queue.jobs.size, 1);
    assert.strictEqual(queue.pending.length, 1);
    assert.ok(queue.find(path.join(root, 'photo.png')));
});

test('a file that could not be opened is looked at again when dropped again', async () => {
    const root = tree('reopen', () => {});
    const file = path.join(root, 'late.png');
    const settings = new Settings(path.join(scratch(), 'reopen.json'));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.start = () => {};
    // Unreadable the first time: expandPaths only returns what exists, so
    // the job is made the way a vanished file leaves it
    fs.writeFileSync(file, 'x'.repeat(100));
    await queue.add([file]);
    const job = queue.find(file);
    queue.pending.length = 0;
    job.waiting = false;
    job.unreadable = true;
    job.setState('error', 'Can’t open the file');

    await queue.add([file]);
    assert.strictEqual(job.unreadable, false);
    assert.strictEqual(queue.pending.length, 1, 'queued this time');
});

// ------------------------------------------------------------- the folder scan

test('expandPaths — stops at the cap and says so', async () => {
    const root = tree('cap', (r) => {
        for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(r, `${i}.png`), 'x');
        fs.writeFileSync(path.join(r, 'notes.txt'), 'not an image');
    });
    const capped = await expandPaths([root], { limit: 3 });
    assert.strictEqual(capped.length, 3);
    assert.strictEqual(capped.truncated, true);
    const all = await expandPaths([root], { limit: 10 });
    assert.strictEqual(all.length, 5);
    assert.strictEqual(all.truncated, false);
});

test('expandPaths — reports how many it has found as it goes', async () => {
    const root = tree('progress', (r) => {
        fs.mkdirSync(path.join(r, 'sub'));
        for (const name of ['a.png', 'b.jpg', 'sub/c.gif']) fs.writeFileSync(path.join(r, name), 'x');
    });
    const counts = [];
    await expandPaths([root], { onProgress: (n) => counts.push(n) });
    assert.deepStrictEqual(counts, [1, 2, 3]);
});

test('a folder still being scanned when Stop is pressed adds nothing', async () => {
    const root = tree('stopscan', (r) => {
        for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(r, `${i}.png`), 'x'.repeat(100));
    });
    const settings = new Settings(path.join(scratch(), 'stopscan.json'));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.start = () => {};
    const adding = queue.add([root]);
    queue.stop();
    assert.deepStrictEqual(await adding, { added: 0, truncated: false });
    assert.strictEqual(queue.jobs.size, 0);
});
