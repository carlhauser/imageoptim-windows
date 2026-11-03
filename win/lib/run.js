'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

// Launches an optimizer and waits for it. Mirrors CommandWorker.m: the child's
// output is captured so tools that only report the result size on stdout can be
// parsed, and the process is killed when the job is cancelled.
//
// Returns { code, signal, output } where output is stdout and stderr joined.
function runTool(options) {
    const {
        exe,
        args,
        cwd,
        stdinPath = null,   // feed this file to the child's stdin
        stdoutPath = null,  // write the child's stdout to this file
        signal = null,      // AbortSignal used to stop the job
        env = null,         // extra environment variables for the child
    } = options;

    return new Promise((resolve, reject) => {
        let stdin = 'ignore';
        let stdout = 'pipe';

        try {
            if (stdinPath) {
                stdin = fs.openSync(stdinPath, 'r');
            }
            if (stdoutPath) {
                stdout = fs.openSync(stdoutPath, 'w');
            }
        } catch (err) {
            reject(err);
            return;
        }

        const closeFds = () => {
            if (typeof stdin === 'number') {
                try { fs.closeSync(stdin); } catch (ignored) { /* already closed */ }
            }
            if (typeof stdout === 'number') {
                try { fs.closeSync(stdout); } catch (ignored) { /* already closed */ }
            }
        };

        let child;
        try {
            child = spawn(exe, args, {
                cwd,
                stdio: [stdin, stdout, 'pipe'],
                windowsHide: true,
                env: env ? { ...process.env, ...env } : process.env,
            });
        } catch (err) {
            closeFds();
            reject(err);
            return;
        }

        let output = '';
        const collect = (chunk) => {
            // Optimizer chatter is small; cap it so a runaway tool cannot
            // exhaust memory.
            if (output.length < 64 * 1024) {
                output += chunk.toString();
            }
        };

        if (child.stdout) child.stdout.on('data', collect);
        if (child.stderr) child.stderr.on('data', collect);

        const onAbort = () => child.kill();
        if (signal) {
            if (signal.aborted) child.kill();
            else signal.addEventListener('abort', onAbort, { once: true });
        }

        child.on('error', (err) => {
            closeFds();
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(err);
        });

        child.on('close', (code, sig) => {
            closeFds();
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({ code, signal: sig, output });
        });
    });
}

// Reads the first integer that follows `marker` on any output line, the way
// CommandWorker's readNumberAfter: does for jpegoptim's "--> 1234 bytes".
function numberAfter(output, marker) {
    for (const line of output.split(/\r?\n/)) {
        const at = line.indexOf(marker);
        if (at < 0) continue;
        const match = /-?\d+/.exec(line.slice(at + marker.length));
        if (match) return parseInt(match[0], 10);
    }
    return 0;
}

// AdvPNG prints "<original> <optimized> <ratio> <name>" per file.
function firstTwoNumbers(output) {
    for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(\d+)\b/.exec(line);
        if (match) {
            return [parseInt(match[1], 10), parseInt(match[2], 10)];
        }
    }
    return null;
}

module.exports = { runTool, numberAfter, firstTwoNumbers };
