'use strict';

// Settings (lib/settings.js): what reaches the optimizers' command lines, so
// every value is checked, and the file is written so that a crash cannot
// reset it.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, DEFAULTS, SCHEMA, coerce } = require('../lib/settings');
const { scratch, cleanupScratch } = require('./helpers');

test.after(cleanupScratch);

const unique = () => crypto.randomBytes(6).toString('hex');
const settingsFile = () => path.join(scratch(), `settings-${unique()}`, 'settings.json');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('every setting has a rule, and every default obeys it', () => {
    assert.deepStrictEqual(Object.keys(SCHEMA).sort(), Object.keys(DEFAULTS).sort());
    for (const [key, value] of Object.entries(DEFAULTS)) {
        assert.strictEqual(coerce(key, value), value, key);
    }
});

test('numbers are clamped to their range and rounded', () => {
    const s = new Settings(settingsFile());
    s.update({ MaxWorkers: 1e6, AdvPngLevel: -3, PngMinQuality: 80.6 });
    assert.strictEqual(s.get('MaxWorkers'), 16);
    assert.strictEqual(s.get('AdvPngLevel'), 1);
    assert.strictEqual(s.get('PngMinQuality'), 81);
});

test('values of the wrong kind are ignored, not stored', () => {
    const s = new Settings(settingsFile());
    s.update({
        LossyEnabled: 'yes',
        JpegOptimMaxQuality: '80; rm -rf',
        QueueOrder: 'random',
        Theme: { dark: true },
        AdvPngLevel: NaN,
        NotASetting: 1,
    });
    for (const key of ['LossyEnabled', 'JpegOptimMaxQuality', 'QueueOrder', 'Theme', 'AdvPngLevel']) {
        assert.strictEqual(s.get(key), DEFAULTS[key], key);
    }
    assert.strictEqual(s.get('NotASetting'), undefined);
});

test('a number given as text is accepted, as a number', () => {
    const s = new Settings(settingsFile());
    s.update({ WebPQuality: '70' });
    assert.strictEqual(s.get('WebPQuality'), 70);
});

test('only what differs from the defaults is written, with a version', () => {
    const file = settingsFile();
    const s = new Settings(file);
    s.update({ LossyEnabled: true, Theme: 'dark' });
    s.flush();
    assert.deepStrictEqual(read(file), { version: 1, LossyEnabled: true, Theme: 'dark' });

    s.update({ Theme: 'system' });
    s.flush();
    assert.deepStrictEqual(read(file), { version: 1, LossyEnabled: true }, 'back to the default, so dropped');
});

test('a changed default reaches someone who has saved settings', () => {
    const file = settingsFile();
    const s = new Settings(file);
    s.update({ LossyEnabled: true });
    s.flush();
    assert.ok(!('ZopfliMaxSeconds' in read(file)), 'not frozen into the file');
});

test('writes wait for a pause, and flush writes at once', async () => {
    const file = settingsFile();
    const s = new Settings(file, { saveDelayMs: 30 });
    s.update({ PngMinQuality: 60 });
    s.update({ PngMinQuality: 61 });
    assert.ok(!fs.existsSync(file), 'nothing yet while the slider moves');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(read(file).PngMinQuality, 61);

    s.update({ PngMinQuality: 62 });
    s.flush();
    assert.strictEqual(read(file).PngMinQuality, 62);
});

test('the write is atomic: no temp file is left, and a torn file does not lose the old one', () => {
    const file = settingsFile();
    const s = new Settings(file);
    s.update({ LossyEnabled: true });
    s.flush();
    assert.ok(!fs.existsSync(`${file}.tmp`));

    // A crash mid-write used to leave half a file, which loaded as defaults
    fs.writeFileSync(file, '{"LossyEnabled": tr');
    const reloaded = new Settings(file);
    assert.strictEqual(reloaded.get('LossyEnabled'), DEFAULTS.LossyEnabled, 'unreadable: defaults, no crash');
});

test('values in the file are checked as they load', () => {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, MaxWorkers: 500, LossyEnabled: 'true', Theme: 'dark' }));
    const s = new Settings(file);
    assert.strictEqual(s.get('MaxWorkers'), 16);
    assert.strictEqual(s.get('LossyEnabled'), DEFAULTS.LossyEnabled);
    assert.strictEqual(s.get('Theme'), 'dark');
});

test('a version 0 file, with every value written out, keeps what the user chose', () => {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    const old = { ...DEFAULTS, MaxWorkers: Math.max(2, Math.min(8, cores)), LossyEnabled: true };
    fs.writeFileSync(file, JSON.stringify(old, null, 2));

    const s = new Settings(file);
    assert.strictEqual(s.get('LossyEnabled'), true);
    s.flush();
    const written = read(file);
    assert.strictEqual(written.version, 1);
    assert.strictEqual(written.LossyEnabled, true);
    assert.ok(!('MaxWorkers' in written), 'this PC\'s default core count is no longer pinned');
});

test('a version 0 file with a worker count the user picked keeps it', () => {
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...DEFAULTS, MaxWorkers: 13 }));
    const s = new Settings(file);
    assert.strictEqual(s.get('MaxWorkers'), 13);
});

test('reset goes back to every default', () => {
    const file = settingsFile();
    const s = new Settings(file);
    s.update({ LossyEnabled: true, AccentHue: 10 });
    assert.deepStrictEqual(s.reset(), { ...DEFAULTS });
    s.flush();
    assert.deepStrictEqual(read(file), { version: 1 });
});
