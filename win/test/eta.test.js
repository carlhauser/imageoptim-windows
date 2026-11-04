'use strict';

// The time-left estimate and the progress bar's fraction (lib/eta.js).

const test = require('node:test');
const assert = require('node:assert');
const { BatchTracker, Fit, describeBatch, timeLeft } = require('../lib/eta');

// A tracker on a clock the test moves by hand
function tracker() {
    const clock = { t: 1_000_000 };
    const t = new BatchTracker({ now: () => clock.t });
    return { t, clock, advance: (ms) => { clock.t += ms; } };
}

// Runs one file through start to finish, taking `ms`
function runFile({ t, advance }, id, cls, bytes, ms, learn = true) {
    t.enqueue(id, cls, bytes);
    t.started(id);
    advance(ms);
    t.finished(id, { learn });
}

test('Fit — recovers a straight line', () => {
    const fit = new Fit();
    for (const x of [1000, 2000, 4000, 8000]) fit.add(x, 50 + 0.01 * x);
    assert.ok(Math.abs(fit.predict(16000) - 210) < 1e-6);
});

test('Fit — in proportion to size until there are three points', () => {
    // Smallest first: the first files done are the small ones, and a file
    // twenty times larger must not be expected to take as long as they did
    const fit = new Fit();
    fit.add(1000, 100);
    fit.add(9000, 900);
    assert.ok(Math.abs(fit.predict(100000) - 10000) < 1e-6);
});

test('Fit — never predicts that larger files are quicker', () => {
    const fit = new Fit();
    fit.add(1000, 900);
    fit.add(2000, 600);
    fit.add(3000, 300);
    assert.ok(fit.predict(10000) > fit.predict(3000), 'a negative slope falls back to proportional');
});

test('estimating until a file of the kind has finished', () => {
    const c = tracker();
    c.t.enqueue('a.png', 'png+zopfli', 10000);
    c.t.enqueue('b.png', 'png+zopfli', 10000);
    let s = c.t.snapshot(4);
    assert.strictEqual(s.estimating, true);
    assert.strictEqual(s.remainingMs, null);
    assert.strictEqual(describeBatch(s).text, '0 of 2 done · estimating time left…');

    c.t.started('a.png');
    c.advance(4000);
    c.t.finished('a.png', { learn: true });
    s = c.t.snapshot(4);
    assert.strictEqual(s.estimating, false);
    assert.ok(Math.abs(s.remainingMs - 4000) < 1, `one more like it: ${s.remainingMs}`);
});

test('an unseen kind is estimated from the others once three files finished', () => {
    const c = tracker();
    for (const id of ['1', '2', '3']) runFile(c, `${id}.jpg`, 'jpeg', 100000, 200);
    c.t.enqueue('x.gif', 'gif', 100000);
    const s = c.t.snapshot(1);
    assert.strictEqual(s.estimating, false);
    assert.ok(s.remainingMs > 0);
});

test('small Zopfli PNGs do not make large PNGs look slow', () => {
    // Smallest-first: many small PNGs that Zopfli works on finish first, each
    // taking seconds. Large PNGs skip Zopfli and are far quicker per byte.
    const c = tracker();
    for (let i = 0; i < 5; i++) runFile(c, `small${i}.png`, 'png+zopfli', 20000 + i * 1000, 5000);
    for (let i = 0; i < 3; i++) runFile(c, `big${i}.png`, 'png', 1000000 * (i + 1), 1000 * (i + 1));
    c.t.end();

    c.t.enqueue('next.png', 'png', 2000000);
    const s = c.t.snapshot(1);
    assert.ok(Math.abs(s.remainingMs - 2000) < 1, `large PNGs keep their own rate: ${s.remainingMs}`);
});

test('time left divides among the workers, but not below the longest running file', () => {
    const c = tracker();
    runFile(c, 'seed.jpg', 'jpeg', 1000, 1000);

    for (let i = 0; i < 8; i++) c.t.enqueue(`f${i}.jpg`, 'jpeg', 1000);
    assert.ok(Math.abs(c.t.snapshot(4).remainingMs - 2000) < 1, '8 files of 1 s on 4 workers');

    // One very slow file running alone sets the floor
    c.t.end();
    runFile(c, 'g.jpg', 'jpeg+guetzli', 1000, 60000);
    c.t.enqueue('h.jpg', 'jpeg+guetzli', 1000);
    c.t.started('h.jpg');
    c.t.enqueue('quick.jpg', 'jpeg', 1000);
    const s = c.t.snapshot(8);
    assert.ok(s.remainingMs >= 60000, `the Guetzli file alone takes a minute: ${s.remainingMs}`);
});

test('files that failed or were stopped teach nothing', () => {
    const c = tracker();
    runFile(c, 'broken.png', 'png', 1000, 50, false);
    c.t.enqueue('next.png', 'png', 1000);
    assert.strictEqual(c.t.snapshot(1).estimating, true);
});

test('the fraction never goes backwards, unless files are added', () => {
    const c = tracker();
    runFile(c, 'a.png', 'png', 1000, 1000);
    c.t.enqueue('b.png', 'png', 1000);
    c.t.enqueue('c.png', 'png', 1000);
    c.t.started('b.png');
    c.advance(800);
    const before = c.t.snapshot(1).fraction;

    // A slow finish makes the remaining file look longer: still no step back
    c.advance(5000);
    c.t.finished('b.png', { learn: true });
    const after = c.t.snapshot(1).fraction;
    assert.ok(after >= before, `${after} >= ${before}`);

    for (let i = 0; i < 10; i++) c.t.enqueue(`more${i}.png`, 'png', 1000);
    assert.ok(c.t.snapshot(1).fraction < after, 'adding files may lower it');
});

test('a file running past its estimate keeps some time left, and its line creeps on', () => {
    const c = tracker();
    runFile(c, 'seed.png', 'png', 1000, 1000);
    c.t.end();
    c.t.enqueue('a.png', 'png', 1000);
    c.t.started('a.png');

    c.advance(500);
    assert.strictEqual(c.t.jobFraction('a.png'), 0.5, 'on schedule, it follows the clock');

    c.advance(3500); // four times the estimate
    const late = c.t.jobFraction('a.png');
    assert.ok(Math.abs(late - 0.9) < 0.01, `about 90%: ${late}`);
    const s = c.t.snapshot(1);
    assert.strictEqual(s.remainingMs, 2000, 'half the four seconds it has run');

    c.advance(30000);
    assert.ok(c.t.jobFraction('a.png') > late, 'still moving');
    assert.ok(c.t.jobFraction('a.png') < 1);
});

test('a row has a fraction as soon as any file has finished', () => {
    const c = tracker();
    c.t.enqueue('big.png', 'png+zopfli', 200000);
    c.t.started('big.png');
    assert.strictEqual(c.t.jobFraction('big.png'), null, 'nothing to go on yet');
    runFile(c, 'small.jpg', 'jpeg', 2000, 100);
    assert.ok(c.t.jobFraction('big.png') > 0, 'the one JPEG is better than nothing');
    assert.strictEqual(c.t.snapshot(1).estimating, true, 'but the batch still says estimating');
});

test('a new batch keeps what was learned', () => {
    const c = tracker();
    runFile(c, 'a.svg', 'svg', 5000, 300);
    c.t.end();
    assert.strictEqual(c.t.active, false);
    c.t.enqueue('b.svg', 'svg', 5000);
    assert.strictEqual(c.t.snapshot(1).estimating, false);
    assert.ok(Math.abs(c.t.predict('svg', 5000) - 300) < 1e-9);
});

test('removing a queued file shrinks the batch', () => {
    const c = tracker();
    c.t.enqueue('a.png', 'png', 1000);
    c.t.enqueue('b.png', 'png', 1000);
    c.t.drop('b.png');
    assert.strictEqual(c.t.snapshot(1).total, 1);
});

test('the countdown is smoothed rather than jumping', () => {
    const c = tracker();
    runFile(c, 'seed.png', 'png', 1000, 10000);
    c.t.end();
    for (let i = 0; i < 6; i++) c.t.enqueue(`f${i}.png`, 'png', 1000);
    const first = c.t.snapshot(1).remainingMs;
    assert.ok(Math.abs(first - 60000) < 1);

    // A file finishes very quickly: the estimate eases down instead of halving
    c.t.started('f0.png');
    c.advance(1000);
    c.t.finished('f0.png', { learn: true });
    const next = c.t.snapshot(1).remainingMs;
    assert.ok(next < first && next > 30000, `eased: ${next}`);
});

test('wording', () => {
    assert.strictEqual(timeLeft(4000), 'a few seconds left');
    assert.strictEqual(timeLeft(42000), 'about 40 s left');
    assert.strictEqual(timeLeft(150000), 'about 3 min left');
    assert.strictEqual(timeLeft(3 * 3600000), 'about 3 h left');
    assert.strictEqual(timeLeft(3600000 + 25 * 60000), 'about 1 h 25 min left');

    const text = describeBatch({ total: 40, done: 12, estimating: false, remainingMs: 125000 });
    assert.deepStrictEqual(text, {
        text: '12 of 40 done · about 2 min left',
        ariaText: '12 of 40 done, about 2 min left',
    });
    assert.strictEqual(describeBatch(null), null);
});
