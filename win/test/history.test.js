'use strict';

// Remembering optimized files across launches (lib/history.js), and how the
// queue and a job use it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { History, hashFile, statKey, profileFor, satisfies } = require('../lib/history');
const { Job } = require('../lib/job');
const { Queue } = require('../lib/queue');
const { Settings } = require('../lib/settings');
const { scratch, cleanupScratch, makeFile, DEFAULTS } = require('./helpers');

test.after(cleanupScratch);

const unique = () => crypto.randomBytes(6).toString('hex');
const storePath = () => path.join(scratch(), `history-${unique()}`, 'optimized.jsonl');
const profile = (overrides = {}) => ({ ...profileFor('png', DEFAULTS), ...overrides });

test('hashFile — the content hash, and the same for a copy elsewhere', async () => {
    const a = makeFile(`h-${unique()}.png`, 'png', 5000);
    const b = path.join(scratch(), `copy-${unique()}.png`);
    fs.copyFileSync(a, b);
    const expected = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex').slice(0, 32);
    assert.strictEqual(await hashFile(a), expected);
    assert.strictEqual(await hashFile(b), expected);
});

test('hashFile — stops when aborted', async () => {
    const file = makeFile(`abort-${unique()}.png`, 'png', 3 << 20);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(hashFile(file, controller.signal));
});

test('finds a file by hash and by stat key after a reload', () => {
    const file = storePath();
    const h = new History(file);
    h.record({ hash: 'a'.repeat(32), key: 'k'.repeat(32), type: 'png', profile: profile() });
    const again = new History(file).load();
    assert.strictEqual(again.count(), 1);
    assert.deepStrictEqual(again.findByHash('a'.repeat(32)).p, profile());
    assert.strictEqual(again.findByStat('k'.repeat(32)).t, 'png');
    assert.strictEqual(again.findByHash('b'.repeat(32)), null);
});

test('statKey — changes with the size, the date or the folder', () => {
    const stat = { size: 10, mtimeMs: 1000 };
    const key = statKey('/x/a.png', stat);
    assert.notStrictEqual(statKey('/x/a.png', { ...stat, size: 11 }), key);
    assert.notStrictEqual(statKey('/x/a.png', { ...stat, mtimeMs: 1001 }), key);
    assert.notStrictEqual(statKey('/y/a.png', stat), key);
    assert.strictEqual(statKey('/x/a.png', { ...stat }), key);
});

test('satisfies — as thorough or more in every respect', () => {
    const wanted = profile();
    assert.ok(satisfies({ p: profile() }, wanted));
    assert.ok(satisfies({ p: profile({ level: wanted.level + 2, lossy: 1 }) }, wanted));
    assert.ok(!satisfies({ p: profile({ level: wanted.level - 1 }) }, wanted), 'a lower effort level');
    assert.ok(!satisfies({ p: profile({ strip: 0 }) }, { ...wanted, strip: 1 }), 'metadata left in');
    assert.ok(!satisfies({ p: profile() }, { ...wanted, lossy: 1 }), 'lossless, now lossy is on');
    assert.ok(!satisfies(null, wanted));
});

test('a line cut short by a crash is skipped', () => {
    const file = storePath();
    new History(file).record({ hash: 'a'.repeat(32), type: 'png', profile: profile() });
    fs.appendFileSync(file, '{"h":"bbbbbbbb');
    const h = new History(file).load();
    assert.strictEqual(h.count(), 1);
    // and appending after it still works
    h.record({ hash: 'c'.repeat(32), type: 'png', profile: profile() });
    assert.strictEqual(new History(file).load().count(), 2);
});

test('compaction keeps the newest files and leaves no temp file', () => {
    const file = storePath();
    let t = 0;
    const h = new History(file, { cap: 4, now: () => ++t });
    for (let i = 0; i < 6; i++) {
        h.record({ hash: String(i).repeat(32), key: `k${i}`, type: 'png', profile: profile() });
    }
    const reloaded = new History(file).load();
    assert.strictEqual(reloaded.count(), 4);
    assert.strictEqual(reloaded.findByHash('0'.repeat(32)), null, 'the oldest went');
    assert.ok(reloaded.findByStat('k5'), 'the newest stayed, with its stat key');
    assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('forget clears the list and the file', () => {
    const file = storePath();
    const h = new History(file);
    h.record({ hash: 'a'.repeat(32), type: 'png', profile: profile() });
    h.forget();
    assert.strictEqual(h.count(), 0);
    assert.ok(!fs.existsSync(file));
    assert.strictEqual(new History(file).load().count(), 0);
});

test('no file or folder names are written to disk', async () => {
    const file = storePath();
    const image = makeFile(`Secret Holiday ${unique()}.png`, 'png', 2000);
    const h = new History(file);
    h.record({ hash: await hashFile(image), key: statKey(image, fs.statSync(image)), type: 'png', profile: profile() });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!/Secret|Holiday|imageoptim-test/i.test(text), text);
});

// ------------------------------------------------------------ in a job

function settingsWith(overrides = {}) {
    const settings = new Settings(path.join(scratch(), `s-${unique()}.json`));
    settings.reset();
    settings.update(overrides);
    return settings;
}

// A PNG with a real header, and a job on it whose optimizers are replaced:
// `result` bytes, if given, are what the one "optimizer" produces.
function jobOn(history, { result, bytes = 4000 } = {}) {
    const file = makeFile(`job-${unique()}.png`, 'png', bytes);
    const job = new Job(file, { resolveTool: () => ({ exe: '/fake/tool' }), history });
    job.originalSize = bytes;
    job.bestSize = bytes;
    let calls = 0;
    job.runTool = async () => {
        calls += 1;
        job.toolsDone += 1;
        if (!result) return null;
        const temp = path.join(scratch(), `out-${unique()}.temp`);
        fs.writeFileSync(temp, result);
        return { temp, size: result.length, label: 'Fake' };
    };
    return { job, file, calls: () => calls };
}

test('a file the history knows is skipped without running anything', async () => {
    const history = new History(storePath());
    const { job, file, calls } = jobOn(history);
    history.record({ hash: await hashFile(file), type: 'png', profile: profile() });

    await job.run({ ...DEFAULTS }, new AbortController().signal);
    assert.strictEqual(job.state, 'skipped');
    assert.strictEqual(calls(), 0);
    assert.strictEqual(job.runCount, 1, 'so Again starts one level up');
});

test('Again (force) runs a known file anyway', async () => {
    const history = new History(storePath());
    const { job, file, calls } = jobOn(history);
    history.record({ hash: await hashFile(file), type: 'png', profile: profile() });
    job.force = true;
    await job.run({ ...DEFAULTS }, new AbortController().signal);
    assert.strictEqual(job.state, 'done');
    assert.ok(calls() > 0);
    assert.strictEqual(job.force, false, 'only once');
});

test('with the setting off, known files are optimized again', async () => {
    const history = new History(storePath());
    const { job, file, calls } = jobOn(history);
    history.record({ hash: await hashFile(file), type: 'png', profile: profile() });
    await job.run({ ...DEFAULTS, SkipOptimized: false }, new AbortController().signal);
    assert.ok(calls() > 0);
});

test('after a save the result is remembered, by content and stat key', async () => {
    const history = new History(storePath());
    const { job, file } = jobOn(history, { result: Buffer.concat([fs.readFileSync(makeFile('hdr.png', 'png', 8)), Buffer.alloc(100)]) });
    const before = await hashFile(file);
    await job.run({ ...DEFAULTS }, new AbortController().signal);
    assert.strictEqual(job.state, 'done');
    assert.ok(job.isOptimized);

    const after = await hashFile(file);
    assert.notStrictEqual(after, before);
    assert.ok(history.findByHash(after), 'the optimized content');
    assert.strictEqual(history.findByHash(before), null, 'not the original');
    assert.ok(history.findByStat(statKey(file, fs.statSync(file))));
});

test('a file nothing could improve is remembered as it is', async () => {
    const history = new History(storePath());
    const { job, file } = jobOn(history);
    await job.run({ ...DEFAULTS }, new AbortController().signal);
    assert.strictEqual(job.state, 'done');
    assert.ok(history.findByHash(await hashFile(file)));
});

test('nothing is remembered for a stopped run', async () => {
    const history = new History(storePath());
    const { job } = jobOn(history, { result: Buffer.alloc(10) });
    const controller = new AbortController();
    job.runTool = async () => { controller.abort(); return null; };
    await job.run({ ...DEFAULTS }, controller.signal);
    assert.strictEqual(job.state, 'stopped');
    assert.strictEqual(history.count(), 0);
});

// ----------------------------------------------------------- in the queue

function folderWith(names) {
    const dir = path.join(scratch(), `q-${unique()}`);
    fs.mkdirSync(dir);
    for (const name of names) fs.writeFileSync(path.join(dir, name), `<svg>${name}</svg>`);
    return dir;
}

async function remember(history, file, type = 'svg') {
    history.record({
        hash: await hashFile(file),
        key: statKey(file, fs.statSync(file)),
        type,
        profile: profileFor(type, DEFAULTS),
    });
}

test('queue — a known, unchanged file goes straight to Done', async () => {
    const dir = folderWith(['known.svg', 'new.svg']);
    const history = new History(storePath());
    await remember(history, path.join(dir, 'known.svg'));

    const queue = new Queue({ settings: settingsWith(), binDir: path.join(scratch(), 'nobin'), history });
    queue.start = () => {};
    await queue.add([dir]);
    assert.strictEqual(queue.jobs.get(path.join(dir, 'known.svg')).state, 'skipped');
    assert.deepStrictEqual(queue.pending.map((j) => j.name), ['new.svg']);
});

test('queue — a changed file is optimized', async () => {
    const dir = folderWith(['edited.svg']);
    const file = path.join(dir, 'edited.svg');
    const history = new History(storePath());
    await remember(history, file);
    fs.appendFileSync(file, '<!-- edited -->');

    const queue = new Queue({ settings: settingsWith(), binDir: path.join(scratch(), 'nobin'), history });
    queue.start = () => {};
    await queue.add([dir]);
    assert.strictEqual(queue.pending.length, 1);
});

test('queue — again() queues skipped files, forced', async () => {
    const dir = folderWith(['known.svg']);
    const history = new History(storePath());
    await remember(history, path.join(dir, 'known.svg'));

    const queue = new Queue({ settings: settingsWith(), binDir: path.join(scratch(), 'nobin'), history });
    queue.start = () => {};
    await queue.add([dir]);
    assert.strictEqual(queue.pending.length, 0);
    queue.again();
    assert.strictEqual(queue.pending.length, 1);
    assert.strictEqual(queue.pending[0].force, true);
});

test('queue — with the setting off, known files are queued', async () => {
    const dir = folderWith(['known.svg']);
    const history = new History(storePath());
    await remember(history, path.join(dir, 'known.svg'));

    const queue = new Queue({ settings: settingsWith({ SkipOptimized: false }), binDir: path.join(scratch(), 'nobin'), history });
    queue.start = () => {};
    await queue.add([dir]);
    assert.strictEqual(queue.pending.length, 1);
});
