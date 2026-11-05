'use strict';

// Keep originals (lib/originals.js): the untouched file is copied into an
// "ImageOptim originals" folder before it is first overwritten. These guard
// the ways it could lose a file: overwriting without a copy, and deleting a
// copy.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Job } = require('../lib/job');
const { History, hashFile, profileFor } = require('../lib/history');
const { Queue, expandPaths } = require('../lib/queue');
const { Settings } = require('../lib/settings');
const { ORIGINALS_DIR, isInOriginals } = require('../lib/originals');
const { scratch, cleanupScratch, DEFAULTS } = require('./helpers');

test.after(cleanupScratch);

const KEEP = { ...DEFAULTS, KeepOriginals: true };
const unique = () => crypto.randomBytes(6).toString('hex');

function folder() {
    const dir = path.join(scratch(), `orig-${unique()}`);
    fs.mkdirSync(dir);
    return dir;
}

// A job in a folder of its own, as it is when the optimizers have finished
function readyJob(dir, name, originalBytes, candidateBytes, options = {}) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, originalBytes);
    // An older date, so a copy that kept it is distinguishable from a fresh one
    const old = new Date('2024-05-01T12:00:00Z');
    fs.utimesSync(file, old, old);
    const stat = fs.statSync(file);

    const job = new Job(file, { resolveTool: () => null, ...options });
    job.type = 'png';
    job.originalSize = stat.size;
    job.bestSize = stat.size;
    job.startSize = stat.size;
    job.startMtimeMs = stat.mtimeMs;
    job.mode = stat.mode;
    job.atime = stat.atime;
    job.mtime = stat.mtime;
    job.giveCandidate = (bytes) => {
        const candidate = path.join(scratch(), `cand-${unique()}.temp`);
        fs.writeFileSync(candidate, bytes);
        job.bestPath = candidate;
        job.bestSize = bytes.length;
    };
    job.giveCandidate(candidateBytes);
    return { job, file };
}

const originalsIn = (dir) => path.join(dir, ORIGINALS_DIR);

test('the first save copies the untouched original, with its date', () => {
    const dir = folder();
    const original = Buffer.alloc(1000, 1);
    const { job, file } = readyJob(dir, 'a.png', original, Buffer.alloc(400, 2));
    job.save(KEEP);

    const kept = path.join(originalsIn(dir), 'a.png');
    assert.ok(fs.readFileSync(kept).equals(original));
    assert.strictEqual(fs.readFileSync(file).length, 400);
    assert.strictEqual(fs.statSync(kept).mtime.toISOString(), '2024-05-01T12:00:00.000Z');
    assert.strictEqual(job.backupIsKept, true);
});

test('with the setting off there is no folder', () => {
    const dir = folder();
    const { job } = readyJob(dir, 'b.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save({ ...DEFAULTS });
    assert.ok(!fs.existsSync(originalsIn(dir)));
    assert.strictEqual(job.backupIsKept, false);
});

test('a second save does not replace the kept copy', () => {
    const dir = folder();
    const original = Buffer.alloc(1000, 1);
    const { job, file } = readyJob(dir, 'c.png', original, Buffer.alloc(400, 2));
    job.save(KEEP);

    const stat = fs.statSync(file);
    job.startSize = stat.size;
    job.startMtimeMs = stat.mtimeMs;
    job.giveCandidate(Buffer.alloc(300, 3));
    job.save(KEEP);

    assert.deepStrictEqual(fs.readdirSync(originalsIn(dir)), ['c.png']);
    assert.ok(fs.readFileSync(path.join(originalsIn(dir), 'c.png')).equals(original));
});

test('a different file of the same name is kept as "name (2)"', () => {
    const dir = folder();
    fs.mkdirSync(originalsIn(dir));
    fs.writeFileSync(path.join(originalsIn(dir), 'd.png'), 'someone else');
    const original = Buffer.alloc(1000, 1);
    const { job } = readyJob(dir, 'd.png', original, Buffer.alloc(400, 2));
    job.save(KEEP);

    assert.strictEqual(fs.readFileSync(path.join(originalsIn(dir), 'd.png'), 'utf8'), 'someone else');
    assert.ok(fs.readFileSync(path.join(originalsIn(dir), 'd (2).png')).equals(original));
});

test('an identical copy already there is reused, and Revert leaves it', () => {
    const dir = folder();
    const original = Buffer.alloc(1000, 1);
    fs.mkdirSync(originalsIn(dir));
    fs.writeFileSync(path.join(originalsIn(dir), 'e.png'), original);
    const { job, file } = readyJob(dir, 'e.png', original, Buffer.alloc(400, 2));
    job.save(KEEP);
    assert.deepStrictEqual(fs.readdirSync(originalsIn(dir)), ['e.png']);
    assert.strictEqual(job.keptCreated, false);

    assert.deepStrictEqual(job.revert(KEEP), { ok: true });
    assert.ok(fs.readFileSync(file).equals(original));
    assert.ok(fs.existsSync(path.join(originalsIn(dir), 'e.png')), 'it was there first');
});

test('Revert moves the copy back and removes the empty folder', () => {
    const dir = folder();
    const original = Buffer.alloc(1000, 1);
    const { job, file } = readyJob(dir, 'f.png', original, Buffer.alloc(400, 2));
    job.save(KEEP);

    assert.deepStrictEqual(job.revert(KEEP), { ok: true });
    assert.ok(fs.readFileSync(file).equals(original));
    assert.strictEqual(fs.statSync(file).mtime.toISOString(), '2024-05-01T12:00:00.000Z');
    assert.ok(!fs.existsSync(originalsIn(dir)));
});

test('Revert refuses when the kept copy was changed', () => {
    const dir = folder();
    const { job, file } = readyJob(dir, 'g.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save(KEEP);
    fs.writeFileSync(path.join(originalsIn(dir), 'g.png'), 'edited by someone');

    const result = job.revert(KEEP);
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /changed/);
    assert.strictEqual(fs.readFileSync(file).length, 400, 'the optimized file stays');
});

test('clearing the list never deletes a kept original', () => {
    const dir = folder();
    const { job } = readyJob(dir, 'h.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save(KEEP);
    job.cleanup();
    assert.ok(fs.existsSync(path.join(originalsIn(dir), 'h.png')));
});

test('if the copy cannot be made, the file is not touched', () => {
    const dir = folder();
    // A file where the folder should be makes creating the folder fail
    fs.writeFileSync(originalsIn(dir), 'in the way');
    const original = Buffer.alloc(1000, 1);
    const { job, file } = readyJob(dir, 'i.png', original, Buffer.alloc(400, 2));
    assert.throws(() => job.save(KEEP));
    assert.ok(fs.readFileSync(file).equals(original));
    assert.strictEqual(job.backupPath, null);
});

test('a file this app already optimized is not kept as an "original"', async () => {
    const dir = folder();
    const history = new History(path.join(scratch(), `h-${unique()}.jsonl`));
    const { job, file } = readyJob(dir, 'j.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2), { history });
    job.inputHash = await hashFile(file);
    history.record({ hash: job.inputHash, type: 'png', profile: profileFor('png', DEFAULTS), written: true });
    job.save(KEEP);
    assert.ok(!fs.existsSync(originalsIn(dir)));
    assert.strictEqual(job.backupIsKept, false);
});

test('a file only remembered as already optimal is still kept before a later save', async () => {
    // Nothing could improve it the first time, so it was remembered as it
    // was. Re-run with lossy on, it gets smaller - and it is still the user's
    // untouched original, so it must be kept before it is overwritten.
    const dir = folder();
    const history = new History(path.join(scratch(), `h-${unique()}.jsonl`));
    const { job, file } = readyJob(dir, 'u.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2), { history });
    job.inputHash = await hashFile(file);
    history.record({ hash: job.inputHash, type: 'png', profile: profileFor('png', DEFAULTS) });
    job.save(KEEP);
    assert.strictEqual(job.backupIsKept, true);
    const kept = path.join(originalsIn(dir), 'u.png');
    assert.ok(fs.readFileSync(kept).every((b) => b === 1), 'the untouched bytes are in the originals folder');
});

test('a folder dropped in is never searched for its originals folder', async () => {
    const dir = folder();
    fs.writeFileSync(path.join(dir, 'top.png'), 'x');
    for (const name of [ORIGINALS_DIR, 'imageoptim ORIGINALS']) {
        fs.mkdirSync(path.join(dir, name), { recursive: true });
        fs.writeFileSync(path.join(dir, name, 'kept.png'), 'x');
    }
    const found = (await expandPaths([dir])).map((p) => path.basename(p));
    assert.deepStrictEqual(found, ['top.png']);
});

test('a file inside an originals folder is listed, refused, and Again leaves it', async () => {
    const dir = folder();
    fs.mkdirSync(originalsIn(dir));
    const kept = path.join(originalsIn(dir), 'k.png');
    fs.writeFileSync(kept, 'x');
    assert.ok(isInOriginals(kept));

    const settings = new Settings(path.join(scratch(), `s-${unique()}.json`));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.start = () => {};
    await queue.add([kept]);
    const job = queue.find(kept);
    assert.strictEqual(job.state, 'error');
    assert.match(job.error, /ImageOptim originals/);
    assert.strictEqual(queue.pending.length, 0);
    queue.again();
    assert.strictEqual(queue.pending.length, 0);
});
