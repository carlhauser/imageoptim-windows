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
// passed, so they did nothing under svgo 1 and are errors under svgo 3.
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
    'removeRasterImages',
    'removeStyleElement',
    'removeTitle',
    'removeUnknownsAndDefaults',
    'removeUnusedNS',
    'removeUselessDefs',
    'removeUselessStrokeAndFill',
    'removeViewBox',
    'removeXMLNS',
];

try {
    const useLossy = process.argv[2];
    const inFile = process.argv[3];
    const outFile = process.argv[4];
    const svgstr = fs.readFileSync(inFile, 'utf8');

    const plugins = useLossy == "1" ? defaults.concat(lossy) : defaults;

    // svgo 3's optimize() is synchronous and throws instead of resolving an
    // error, and listing plugins explicitly replaces preset-default the way
    // svgo 1's `full: true` did.
    const result = optimize(svgstr, {
        path: inFile,
        plugins: plugins,
    });

    if (!result || typeof result.data !== 'string') {
        console.error("svgo produced no output");
        process.exit(1);
    }

    fs.writeFileSync(outFile, result.data);
} catch (err) {
    console.error(err);
    process.exit(1);
}
