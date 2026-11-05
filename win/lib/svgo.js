'use strict';

// SVGO, the one optimizer written in JavaScript: resources/svgo.js, a webpack
// bundle of svgo/index.js.
//
// It used to be started for every SVG as a whole Electron process running as
// Node (ELECTRON_RUN_AS_NODE), which took 100-300 ms and some 60 MB before it
// read a byte, and which stops working once the packaged app turns that
// switch off (its Electron fuses). In the app it now runs in utility
// processes that load the bundle once and are handed one file after another:
// as many as there are SVGs being optimized at once, each kept for a while
// after its last file. Under plain Node - the tests - there is no utility
// process, and it is started per file as before.

const run = require('./run');

const IDLE_MS = 30000;

function utilityProcess() {
    if (!process.versions.electron || process.type !== 'browser') return null;
    try {
        return require('electron').utilityProcess || null;
    } catch (err) {
        return null;
    }
}

const idle = []; // workers with nothing to do, newest last
let nextId = 0;

function startWorker(script) {
    const child = utilityProcess().fork(script, [], { serviceName: 'ImageOptim SVGO', stdio: 'ignore' });
    const worker = { child, script, current: null, timer: null, dead: false };
    child.on('message', (message) => {
        const current = worker.current;
        if (current && message && message.id === current.id) {
            worker.current = null;
            current.resolve(message);
        }
    });
    child.on('exit', () => {
        worker.dead = true;
        const at = idle.indexOf(worker);
        if (at >= 0) idle.splice(at, 1);
        if (worker.current) {
            const current = worker.current;
            worker.current = null;
            current.resolve({ ok: false, error: 'SVGO stopped' });
        }
    });
    return worker;
}

function takeWorker(script) {
    while (idle.length) {
        const worker = idle.pop();
        clearTimeout(worker.timer);
        if (!worker.dead && worker.script === script) return worker;
        if (!worker.dead) worker.child.kill();
    }
    return startWorker(script);
}

function giveBack(worker) {
    if (worker.dead) return;
    worker.timer = setTimeout(() => {
        const at = idle.indexOf(worker);
        if (at >= 0) idle.splice(at, 1);
        worker.child.kill();
    }, IDLE_MS);
    if (worker.timer.unref) worker.timer.unref();
    idle.push(worker);
}

async function inWorker({ script, lossy, input, output, signal }) {
    if (signal && signal.aborted) return { code: null, output: '' };
    const worker = takeWorker(script);
    const id = ++nextId;
    // Stop and the time limit cannot interrupt svgo halfway through a file,
    // so they end its process; the next SVG gets a fresh one.
    const onAbort = () => worker.child.kill();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const reply = await new Promise((resolve) => {
        worker.current = { id, resolve };
        worker.child.postMessage({ id, lossy, input, output });
    });
    if (signal) signal.removeEventListener('abort', onAbort);
    giveBack(worker);
    return { code: reply.ok ? 0 : 1, output: reply.error || '' };
}

// Runs SVGO on one file. Returns { code, output } like run.runTool.
function optimize({ script, lossy, input, output, signal }) {
    if (utilityProcess()) return inWorker({ script, lossy, input, output, signal });
    return run.runTool({
        exe: process.execPath,
        args: [script, lossy ? '1' : '0', input, output],
        signal,
        env: { ELECTRON_RUN_AS_NODE: '1' },
    });
}

// On quit, so no worker outlives the app
function stopAll() {
    for (const worker of idle.splice(0)) {
        clearTimeout(worker.timer);
        worker.child.kill();
    }
}

module.exports = { optimize, stopAll };
