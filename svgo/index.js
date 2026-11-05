"use strict";

const { optimize } = require('svgo');
const fs = require('fs');

const defaults = [
    'cleanupAttrs',
    'cleanupListOfValues',
    'cleanupNumericValues',
    'convertColors',
    'convertStyleToAttrs',
    'minifyStyles',
    'moveGroupAttrsToElems',
    'removeComments',
    'removeDoctype',
    'removeEditorsNSData',
    'removeEmptyAttrs',
    'removeEmptyContainers',
    'removeEmptyText',
    'removeNonInheritableGroupAttrs',
    'removeXMLProcInst',
    'sortAttrs',
];

// addAttributesToSVGElement, addClassesToSVGElement, removeAttrs and
// removeElementsByAttr are omitted: they need parameters this script never
// passed, so they did nothing under svgo 1 and are errors since svgo 3.
//
// So are four that change what a standalone file shows rather than how it is
// written: removeXMLNS (meant for SVG inlined in HTML; a .svg file without its
// namespace no longer opens as an image), removeRasterImages (drops embedded
// pictures), removeStyleElement (drops the CSS the drawing is styled with),
// and removeViewBox, which together with removeDimensions left a file with no
// size at all.
const lossy = [
    'cleanupEnableBackground',
    'cleanupIds', // renamed from cleanupIDs in svgo 2
    'collapseGroups',
    'convertPathData',
    'convertShapeToPath',
    'convertTransform',
    'mergePaths',
    'moveElemsAttrsToGroup',
    'removeDesc',
    'removeDimensions',
    'removeHiddenElems',
    'removeMetadata',
    'removeTitle',
    'removeUnknownsAndDefaults',
    'removeUnusedNS',
    'removeUselessDefs',
    'removeUselessStrokeAndFill',
];

// Optimizes inFile into outFile. Throws if svgo cannot.
function optimizeFile(useLossy, inFile, outFile) {
    const svgstr = fs.readFileSync(inFile, 'utf8');

    const plugins = useLossy == "1" ? defaults.concat(lossy) : defaults;

    // Since svgo 3 optimize() is synchronous and throws instead of resolving
    // an error, and listing plugins explicitly replaces preset-default the way
    // svgo 1's `full: true` did - so svgo 4 dropping removeViewBox and
    // removeTitle from that preset changes nothing here.
    const result = optimize(svgstr, {
        path: inFile,
        // Another pass often finds a little more once the first has merged
        // paths and collapsed groups
        multipass: true,
        plugins: plugins,
    });

    if (!result || typeof result.data !== 'string') {
        throw new Error("svgo produced no output");
    }

    fs.writeFileSync(outFile, result.data);
}

if (process.parentPort) {
    // Started by the Windows app as an Electron utility process, which keeps
    // it and sends it one file after another: the bundle is loaded once, not
    // for every SVG. Each message is { id, lossy, input, output }; the reply
    // says whether it worked.
    process.parentPort.on('message', (event) => {
        const { id, lossy: useLossy, input, output } = event.data;
        try {
            optimizeFile(useLossy ? "1" : "0", input, output);
            process.parentPort.postMessage({ id, ok: true });
        } catch (err) {
            process.parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
        }
    });
} else {
    // A command line: svgo.js <lossy 0|1> <input> <output>
    try {
        optimizeFile(process.argv[2], process.argv[3], process.argv[4]);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}
