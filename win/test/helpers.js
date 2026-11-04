'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// tools.js pulls in electron for the Guetzli path only. Stub it so the suite
// runs under plain node.
const realLoad = Module._load;

// Guetzli decodes its input before handing it to the binary, so the stub returns
// a real PNG. Filler bytes made the binary test fail with "Marker byte (0xff)
// expected" - the test's fault, not the code's.
const SAMPLE_PNG = path.join(__dirname, '..', '..', 'libpng', 'pngbar.png');

Module._load = function (request, ...rest) {
    if (request === 'electron') {
        return {
            nativeImage: {
                createFromPath: () => ({
                    isEmpty: () => false,
                    toPNG: () => (fs.existsSync(SAMPLE_PNG)
                        ? fs.readFileSync(SAMPLE_PNG)
                        : Buffer.from('fake-png-bytes')),
                }),
            },
        };
    }
    return realLoad.call(this, request, ...rest);
};

const run = require('../lib/run');
const tools = require('../lib/tools');
const { DEFAULTS } = require('../lib/settings');

let scratchRoot = null;

function scratch() {
    if (!scratchRoot) {
        scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'imageoptim-test-'));
    }
    return scratchRoot;
}

function cleanupScratch() {
    if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = null;
}

// A file whose first bytes identify it as the given format. The optimizers are
// stubbed, so only the header and the size matter.
const HEADERS = {
    png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    gif: Buffer.from('GIF89a'),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
};

function makeFile(name, type, bytes = 4096) {
    const file = path.join(scratch(), name);
    const header = HEADERS[type];
    const body = Buffer.alloc(Math.max(0, bytes - header.length), 0x41);
    fs.writeFileSync(file, Buffer.concat([header, body]));
    return file;
}

// Runs one optimizer with runTool replaced, and returns the argv it would have
// used. Nothing is spawned.
async function captureArgs(toolId, { settings = {}, input, type = 'png', size = 4096, level = 4, extra = {} } = {}) {
    const tool = tools.ALL.find((t) => t.id === toolId);
    if (!tool) throw new Error(`no such tool: ${toolId}`);

    const inputPath = input || makeFile(`${toolId}-in.${type}`, type, size);
    const tempPath = path.join(scratch(), `${toolId}-out.tmp`);

    let captured = null;
    const realRunTool = run.runTool;
    run.runTool = async (options) => {
        captured = options;
        // Satisfy the tools that parse output for the resulting size
        fs.writeFileSync(tempPath, 'x'.repeat(16));
        return { code: 0, output: ' --> 16 bytes\n16 16 100% out\n' };
    };

    try {
        await tool.run({
            input: { path: inputPath, byteSize: fs.statSync(inputPath).size, type },
            temp: tempPath,
            settings: { ...DEFAULTS, ...settings },
            level,
            alternativeStrategy: false,
            lossyGif: false,
            signal: new AbortController().signal,
            exe: `/fake/bin/${tool.exe || 'tool'}`,
            script: '/fake/resources/svgo.js',
            ...extra,
        });
    } finally {
        run.runTool = realRunTool;
    }

    if (!captured) throw new Error(`${toolId} never reached runTool`);
    return { args: captured.args, options: captured, inputPath, tempPath };
}

module.exports = { captureArgs, makeFile, scratch, cleanupScratch, tools, run, DEFAULTS };
