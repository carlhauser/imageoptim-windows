'use strict';

// The parts that can destroy a file: adopting a result, writing it over the
// original, and putting the original back.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Job } = require('../lib/job');
const { DEFAULTS } = require('../lib/settings');
const { scratch, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

// A job positioned exactly as it is when the optimizers have finished: the
// original on disk, its stats recorded at the start of the run, and a smaller
// candidate waiting in bestPath.
function readyJob(name, originalBytes, candidateBytes) {
    const file = path.join(scratch(), name);
    fs.writeFileSync(file, originalBytes);
    const stat = fs.statSync(file);

    const job = new Job(file, { resolveTool: () => null });
    job.type = 'png';
    job.originalSize = stat.size;
    job.bestSize = stat.size;
    job.startSize = stat.size;
    job.startMtimeMs = stat.mtimeMs;
    job.mode = stat.mode;
    job.atime = stat.atime;
    job.mtime = stat.mtime;

    if (candidateBytes) {
        const candidate = path.join(scratch(), `${name}.candidate`);
        fs.writeFileSync(candidate, candidateBytes);
        job.bestPath = candidate;
        job.bestSize = candidateBytes.length;
    }
    return { job, file };
}

const stray = () => fs.readdirSync(scratch()).filter((n) => n.startsWith('.imageoptim-'));

test('adopt keeps the smaller result and discards the rest', () => {
    const { job } = readyJob('adopt.png', Buffer.alloc(1000, 1));
    const big = path.join(scratch(), 'big.tmp');
    const small = path.join(scratch(), 'small.tmp');
    fs.writeFileSync(big, Buffer.alloc(900));
    fs.writeFileSync(small, Buffer.alloc(400));

    assert.strictEqual(job.adopt(big, 900, 'BigTool'), true);
    assert.strictEqual(job.bestSize, 900);

    assert.strictEqual(job.adopt(small, 400, 'SmallTool'), true);
    assert.strictEqual(job.bestSize, 400);
    assert.strictEqual(job.bestTool, 'SmallTool');
    assert.ok(!fs.existsSync(big), 'the superseded candidate is deleted');
});

test('adopt rejects a result that is not smaller', () => {
    const { job } = readyJob('adopt2.png', Buffer.alloc(1000, 1));
    const same = path.join(scratch(), 'same.tmp');
    fs.writeFileSync(same, Buffer.alloc(1000));
    assert.strictEqual(job.adopt(same, 1000, 'NoGain'), false);
    assert.strictEqual(job.bestSize, 1000);
    assert.strictEqual(job.bestTool, null);
    assert.ok(!fs.existsSync(same), 'the rejected candidate is deleted too');
});

test('save replaces the original and leaves no staging file', () => {
    const { job, file } = readyJob('save.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save(DEFAULTS);

    assert.strictEqual(fs.statSync(file).size, 400);
    assert.ok(fs.readFileSync(file).every((b) => b === 2), 'contents are the optimized ones');
    assert.deepStrictEqual(stray(), [], 'no .imageoptim-* staging file survives');
    assert.strictEqual(job.bestPath, null);
});

test('save records what is actually on disk, not the temp file size', () => {
    const { job, file } = readyJob('save2.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save(DEFAULTS);
    const onDisk = fs.statSync(file);
    assert.strictEqual(job.lastSavedSize, onDisk.size);
    assert.strictEqual(job.lastSavedMtimeMs, onDisk.mtimeMs);
});

test('save keeps a backup of the original', () => {
    const { job } = readyJob('save3.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save(DEFAULTS);
    assert.ok(job.backupPath && fs.existsSync(job.backupPath));
    assert.strictEqual(fs.statSync(job.backupPath).size, 1000);
    assert.ok(job.canRevert);
});

test('save refuses when the file changed while optimizers were running', () => {
    const { job, file } = readyJob('stale.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    // another program rewrites it mid-run, at a different size
    fs.writeFileSync(file, Buffer.alloc(1234, 9));

    assert.throws(() => job.save(DEFAULTS), /changed on disk/);
    assert.strictEqual(fs.statSync(file).size, 1234, 'the newer file is untouched');
    assert.ok(fs.readFileSync(file).every((b) => b === 9));
    assert.deepStrictEqual(stray(), []);
});

test('save refuses when the file vanished', () => {
    const { job, file } = readyJob('gone.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    fs.unlinkSync(file);
    assert.throws(() => job.save(DEFAULTS), /no longer there/);
});

test('revert restores the original byte for byte', () => {
    const original = Buffer.from('original contents, exactly these bytes');
    const { job, file } = readyJob('revert.png', original, Buffer.alloc(8, 2));
    job.save(DEFAULTS);
    assert.notStrictEqual(fs.statSync(file).size, original.length);

    const result = job.revert(DEFAULTS);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(fs.readFileSync(file), original);
    assert.strictEqual(job.bestTool, null);
    assert.deepStrictEqual(stray(), []);
});

test('revert refuses once something else has changed the file', () => {
    const { job, file } = readyJob('revert2.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save(DEFAULTS);
    // the user edits the optimized file in another program
    fs.writeFileSync(file, Buffer.alloc(777, 7));

    const result = job.revert(DEFAULTS);
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /changed by something else/);
    assert.strictEqual(fs.statSync(file).size, 777, 'their version survives');
});

test('revert reports when there is nothing to restore', () => {
    const { job } = readyJob('norevert.png', Buffer.alloc(100, 1));
    const result = job.revert(DEFAULTS);
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /no backup/);
});

test('cleanup removes the backup, not just the candidate', () => {
    const { job } = readyJob('cleanup.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    job.save(DEFAULTS);
    const backup = job.backupPath;
    assert.ok(fs.existsSync(backup));

    job.cleanup();
    assert.ok(!fs.existsSync(backup), 'a backup left behind is a full copy of every optimized file');
    assert.strictEqual(job.backupPath, null);
});

test('percentOptimized measures against the first size seen, not the last', () => {
    const { job } = readyJob('pct.png', Buffer.alloc(1000, 1));
    job.originalSize = 1000;
    job.bestSize = 250;
    assert.strictEqual(Math.round(job.percentOptimized), 75);
    assert.strictEqual(job.isOptimized, true);

    job.bestSize = 1000;
    assert.strictEqual(job.percentOptimized, 0);
    assert.strictEqual(job.isOptimized, false);
});

// ------------------------------------------------- when the rename is refused
//
// Antivirus scanners, the search indexer, OneDrive and viewers hold a file
// open for a moment after it changes, and Windows then refuses the rename.
// These replace fs calls for one test at a time.

const { RENAME_RETRY } = require('../lib/job');

function withFs(overrides, fn) {
    const saved = {};
    for (const [name, impl] of Object.entries(overrides)) {
        saved[name] = fs[name];
        fs[name] = impl(saved[name]);
    }
    const delay = RENAME_RETRY.delayMs;
    RENAME_RETRY.delayMs = 1;
    try {
        return fn();
    } finally {
        Object.assign(fs, saved);
        RENAME_RETRY.delayMs = delay;
    }
}

const fsError = (code) => Object.assign(new Error(`${code}: refused`), { code });

test('save retries a rename the file was briefly locked for', () => {
    const { job, file } = readyJob('locked.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    let renames = 0;
    let directCopies = 0;
    withFs({
        renameSync: (real) => (from, to) => {
            renames += 1;
            if (renames <= 2) throw fsError('EBUSY');
            return real(from, to);
        },
        copyFileSync: (real) => (from, to, mode) => {
            if (to === file) directCopies += 1;
            return real(from, to, mode);
        },
    }, () => job.save(DEFAULTS));

    assert.strictEqual(renames, 3);
    assert.strictEqual(directCopies, 0, 'the atomic rename got through, so no direct copy');
    assert.ok(fs.readFileSync(file).every((b) => b === 2));
    assert.deepStrictEqual(stray(), []);
});

test('save gives up on the rename after a few tries, and only for a lock', () => {
    const { job, file } = readyJob('refused.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    let renames = 0;
    withFs({
        renameSync: () => () => { renames += 1; throw fsError('EPERM'); },
    }, () => job.save(DEFAULTS));
    assert.strictEqual(renames, RENAME_RETRY.attempts);
    assert.ok(fs.readFileSync(file).every((b) => b === 2), 'the direct copy wrote the result');

    const other = readyJob('refused-other.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    renames = 0;
    withFs({
        renameSync: () => () => { renames += 1; throw fsError('EXDEV'); },
    }, () => other.job.save(DEFAULTS));
    assert.strictEqual(renames, 1, 'not a lock, so no point waiting');
});

test('a direct copy that fails halfway puts the original back', () => {
    const { job, file } = readyJob('half.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    assert.throws(() => withFs({
        renameSync: () => () => { throw fsError('EPERM'); },
        copyFileSync: (real) => (from, to, mode) => {
            if (to === file && from !== job.backupPath) {
                fs.writeFileSync(file, Buffer.alloc(10, 2)); // truncated
                throw fsError('ENOSPC');
            }
            return real(from, to, mode);
        },
    }, () => job.save(DEFAULTS)), /put back/);

    const now = fs.readFileSync(file);
    assert.strictEqual(now.length, 1000);
    assert.ok(now.every((b) => b === 1), 'the original bytes, whole');
});

test('if the original cannot be put back either, its backup is saved beside it', () => {
    const { job, file } = readyJob('rescue.png', Buffer.alloc(1000, 1), Buffer.alloc(400, 2));
    let message = '';
    try {
        withFs({
            renameSync: () => () => { throw fsError('EPERM'); },
            copyFileSync: (real) => (from, to, mode) => {
                if (to === file) {
                    fs.writeFileSync(file, Buffer.alloc(10, 2));
                    throw fsError('EIO');
                }
                return real(from, to, mode);
            },
        }, () => job.save(DEFAULTS));
    } catch (err) {
        message = err.message;
    }
    const rescued = path.join(path.dirname(file), 'rescue (ImageOptim backup).png');
    assert.ok(message.includes(rescued), message);
    assert.ok(fs.readFileSync(rescued).every((b) => b === 1), 'the untouched original');
    job.cleanup();
    assert.ok(fs.existsSync(rescued), 'cleanup never removes the rescued copy');
});
