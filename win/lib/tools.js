'use strict';

const fs = require('fs');
const path = require('path');
// Imported as a namespace rather than destructured so tests can substitute
// runTool and capture the exact argv each optimizer would be given.
const run = require('./run');
const svgoRunner = require('./svgo');
const { PNG, JPEG, GIF, SVG, WEBP, AVIF, isSmall, isLarge } = require('./filetype');

// One entry per optimizer, ported from imageoptim/Backend/Workers/*.m. The
// command lines are deliberately identical to the macOS app's: these flags are
// the result of years of tuning and of working around decoder bugs (gifsicle's
// --careful, pngcrush's 70-byte truncated output, jpegoptim's 5% lossy floor).
//
// A tool's run() writes a candidate file to ctx.temp and returns its size, or
// null when it produced nothing useful. Deciding whether to keep the candidate
// belongs to the job, which keeps whichever output is smallest.

// How a multi-threaded tool is told how many threads it may use (ctx.threads,
// from lib/semaphore.js threadsPerSlot). oxipng and pngquant run on rayon,
// which reads RAYON_NUM_THREADS; oxipng also takes -t. Absent, as in the
// argument tests, a tool keeps its own default.
function rayonEnv(ctx) {
    return ctx.threads ? { RAYON_NUM_THREADS: String(ctx.threads) } : null;
}

function statSize(filePath) {
    try {
        return fs.statSync(filePath).size;
    } catch (err) {
        return 0;
    }
}

const oxipng = {
    id: 'oxipng',
    exe: 'oxipng',
    label: 'OxiPNG',
    types: [PNG],
    lossy: false,
    enabled: (s) => s.OptiPngEnabled,
    async run(ctx) {
        const optlevel = Math.max(2, Math.min(ctx.level, 6));
        const args = [`-o${optlevel}`, '-i0', '-a', '--out', ctx.temp, '--', ctx.input.path];
        if (ctx.settings.PngOutRemoveChunks) {
            args.unshift('--strip=safe');
        }
        if (ctx.threads) args.splice(args.indexOf('--out'), 0, '-t', String(ctx.threads));

        const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal, env: rayonEnv(ctx) });
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: 'OxiPNG' };
    },
};

const pngquant = {
    id: 'pngquant',
    exe: 'pngquant',
    label: 'pngquant',
    types: [PNG],
    lossy: true,
    enabled: (s) => s.LossyEnabled && s.PngMinQuality < 100 && s.PngMinQuality > 30,
    async run(ctx) {
        const minQuality = ctx.settings.PngMinQuality;
        const maxQuality = Math.min(100, minQuality + 20);
        // MIN(3, 7 - level) as in PngquantWorker.m, but never below 1: the
        // effort slider reaches 7, and Again adds one, and pngquant rejects
        // -s0 and -s-1 outright, which turned lossy PNG off without a word.
        const speed = Math.max(1, Math.min(3, 7 - ctx.level));

        const args = [
            '256', '--skip-if-larger',
            `-s${speed}`,
            '--quality', `${minQuality}-${maxQuality}`,
            '-',
        ];

        const { code } = await run.runTool({
            exe: ctx.exe,
            args,
            stdinPath: ctx.input.path,
            stdoutPath: ctx.temp,
            signal: ctx.signal,
            env: rayonEnv(ctx),
            expectedCodes: [98, 99],
        });

        // 98 = output was not smaller, 99 = quality floor not reachable. Both are
        // pngquant declining the image, not an error.
        if (code === 98 || code === 99) return null;
        if (code !== 0) return null;
        // --skip-if-larger only refuses a file that grew: a palette for a
        // few bytes is still a generation of loss for nothing
        const size = statSize(ctx.temp);
        if (!lossyWorthIt(ctx, size)) return null;
        return { size, label: 'pngquant', lossy: true };
    },
};

const zopflipng = {
    id: 'zopflipng',
    exe: 'zopflipng',
    label: 'Zopfli',
    types: [PNG],
    lossy: true, // rewrites the file wholesale, so it must run before the others
    idempotent: false,
    enabled: (s) => s.ZopfliEnabled,
    async run(ctx) {
        const strip = ctx.settings.PngOutRemoveChunks;
        const iterations = 3 + 3 * ctx.level;

        // timelimitForLevel: in CommandWorker.m
        let timelimit = Math.min(8 + ctx.level * 13, 10 + Math.floor(ctx.input.byteSize / 1024));

        // Zopfli is by far the most expensive step and its last seconds buy
        // almost nothing, so cap the budget unless the user asks for the
        // uncapped original.
        const budget = ctx.settings.ThoroughPng ? 0 : Number(ctx.settings.ZopfliMaxSeconds);
        if (budget > 0) {
            timelimit = Math.min(timelimit, budget);
        }

        let actualIterations = iterations;
        let filters = '--filters=0pme';

        if (isLarge(ctx.input.type, ctx.input.byteSize)) {
            actualIterations = 5 + Math.floor(actualIterations / 3);
            filters = '--filters=p';
        }

        if (ctx.alternativeStrategy) {
            timelimit = budget > 0 ? timelimit : timelimit * 1.4;
            filters = '--filters=bp';
        } else {
            timelimit *= 0.8;
        }

        const args = ['--lossy_transparent', '-y', ctx.input.path, ctx.temp];
        if (!strip) {
            args.unshift('--keepchunks=tEXt,zTXt,iTXt,gAMA,sRGB,iCCP,bKGD,pHYs,sBIT,tIME,oFFs,acTL,fcTL,fdAT,prVW,mkBF,mkTS,mkBS,mkBT');
        }
        args.unshift(filters);
        if (actualIterations) {
            args.unshift(`--iterations=${actualIterations}`);
        }
        args.unshift(`--timelimit=${Math.round(timelimit)}`);

        const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;

        const size = statSize(ctx.temp);
        if (size <= 70) return null; // only a PNG header came out
        return { size, label: 'Zopfli' };
    },
};

const advpng = {
    id: 'advpng',
    exe: 'advpng',
    label: 'AdvPNG',
    types: [PNG],
    lossy: false,
    // AdvPNG cannot preserve ancillary chunks, so the macOS app only runs it when
    // metadata stripping is allowed.
    enabled: (s) => s.AdvPngEnabled && s.PngOutRemoveChunks,
    async run(ctx) {
        const level = Math.max(1, Math.min(4, ctx.level));
        await fs.promises.copyFile(ctx.input.path, ctx.temp); // advpng rewrites in place

        const args = [`-${level}`, '-z', '--', ctx.temp];
        const { code, output } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;

        const numbers = run.firstTwoNumbers(output);
        if (!numbers) return null;

        const reported = numbers[1];
        // tempCopyOfPath:size: refuses a mismatch between the reported and real size
        if (!reported || reported !== statSize(ctx.temp)) return null;
        return { size: reported, label: 'AdvPNG' };
    },
};

const pngcrush = {
    id: 'pngcrush',
    exe: 'pngcrush',
    label: 'Pngcrush',
    types: [PNG],
    lossy: false, // true only when stripping, handled in makesNonOptimizingModifications
    enabled: (s) => s.PngCrush2Enabled,
    makesNonOptimizingModifications: (s) => Boolean(s.PngOutRemoveChunks),
    async run(ctx) {
        const strip = ctx.settings.PngOutRemoveChunks;
        const brute = ctx.level >= 6;
        const small = isSmall(ctx.input.type, ctx.input.byteSize);
        const large = isLarge(ctx.input.type, ctx.input.byteSize);

        const args = ['-nofilecheck', '-bail', '-blacken', '-reduce', '-cc', '--', ctx.input.path, ctx.temp];
        if (strip) {
            args.unshift('-rem', 'alla');
        }
        if (small || (brute && !large)) {
            args.unshift('-brute');
        }

        const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;

        const size = statSize(ctx.temp);
        if (size <= 70) return null; // pngcrush sometimes writes only the header
        return { size, label: 'Pngcrush' };
    },
};

const jpegoptim = {
    id: 'jpegoptim',
    exe: 'jpegoptim',
    label: 'JpegOptim',
    types: [JPEG],
    lossy: false,
    enabled: (s) => s.JpegOptimEnabled,
    makesNonOptimizingModifications: (s) => (s.LossyEnabled ? s.JpegOptimMaxQuality : 100) < 100,
    async run(ctx) {
        const strip = ctx.settings.JpegTranStripAll;
        const maxquality = ctx.settings.LossyEnabled ? ctx.settings.JpegOptimMaxQuality : 100;
        const lossy = maxquality > 10 && maxquality < 100;

        await fs.promises.copyFile(ctx.input.path, ctx.temp); // jpegoptim rewrites in place

        const args = [
            strip ? '--strip-all' : '--strip-none',
            // Lossless progressive would duplicate jpegtran's work, but a lossy
            // baseline pass would stop the two from running in parallel.
            lossy ? '--all-progressive' : '--all-normal',
            '-v', // the only way to learn the output size
            '--', ctx.temp,
        ];
        if (lossy) {
            args.unshift(`-m${maxquality}`);
        }

        const { output } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
        const reported = run.numberAfter(output, ' --> ');
        if (!reported || reported !== statSize(ctx.temp)) return null;

        if (lossy && !(ctx.input.byteSize * 0.95 > reported)) {
            return null; // demand at least 5% for a lossy pass
        }

        return { size: reported, label: lossy ? `JpegOptim ${maxquality}%` : 'JpegOptim', lossy };
    },
};

const jpegtran = {
    id: 'jpegtran',
    exe: 'jpegtran',
    label: 'MozJPEG',
    types: [JPEG],
    lossy: false,
    enabled: (s) => s.JpegTranEnabled,
    async run(ctx) {
        const strip = ctx.settings.JpegTranStripAll;
        const args = [
            '-copy', strip ? 'none' : 'all',
            '-optimize',
            '-outfile', ctx.temp,
            ctx.input.path,
        ];

        // Run from the executable's own directory so Windows finds any DLL that
        // ships beside it.
        const { code } = await run.runTool({
            exe: ctx.exe,
            args,
            cwd: path.dirname(ctx.exe),
            signal: ctx.signal,
        });
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: 'MozJPEG' };
    },
};

const guetzli = {
    id: 'guetzli',
    exe: 'guetzli',
    label: 'Guetzli',
    types: [JPEG],
    lossy: true,
    // One at a time across every file, as GuetzliWorker.m does: each run may
    // take gigabytes (--memlimit 6000 below), and one per worker slot could
    // ask for ten times what the PC has. See lib/job.js runTool.
    exclusive: true,
    enabled: (s) => s.GuetzliEnabled && s.JpegOptimMaxQuality >= 80,
    async run(ctx) {
        let level = ctx.settings.LossyEnabled ? ctx.settings.JpegOptimMaxQuality : 95;
        if (level < 84) level = 84;

        // Guetzli wants an uncompressed input, so hand it a decoded PNG. The
        // macOS app also converts to sRGB with ColorSync; Electron's nativeImage
        // has no colour-management entry point, so an image carrying an exotic
        // ICC profile may shift slightly. Guetzli is off by default.
        const { nativeImage } = require('electron');
        const decoded = nativeImage.createFromPath(ctx.input.path);
        if (decoded.isEmpty()) return null;
        fs.writeFileSync(ctx.temp, decoded.toPNG());

        const small = isSmall(ctx.input.type, ctx.input.byteSize);
        const args = [
            '--quality', String(level),
            '--memlimit', small ? '2000' : '6000',
            ctx.temp, ctx.temp,
        ];

        const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: 'Guetzli', lossy: true };
    },
};

function makeGifsicle(interlace) {
    const label = interlace ? 'Gifsicle interlaced' : 'Gifsicle';
    return {
        id: interlace ? 'gifsicle-interlaced' : 'gifsicle',
        exe: 'gifsicle',
        label,
        types: [GIF],
        lossy: false,
        enabled: (s) => s.GifsicleEnabled,
        async run(ctx) {
            const quality = ctx.lossyGif ? ctx.settings.GifQuality : 100;
            const isLossy = quality < 100;

            const args = [
                '-o', ctx.temp,
                interlace ? '--interlace' : '--no-interlace',
                '-O3',
                '--careful', // needed for Safari/Preview decoding bug
                '--no-comments', '--no-names', '--same-delay', '--same-loopcount', '--no-warnings',
                '--', ctx.input.path,
            ];

            if (isLossy) {
                let loss = Math.floor(Math.pow(100 - quality, 1.8) / 5.0);
                if (isSmall(ctx.input.type, ctx.input.byteSize)) {
                    loss = 1 + Math.floor(loss / 8); // spare GIF icons
                } else if (!isLarge(ctx.input.type, ctx.input.byteSize)) {
                    loss = 1 + Math.floor(loss / 2); // spare GIF images
                }
                args.unshift(`--lossy=${loss}`);
            }

            const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
            if (code !== 0) return null;

            const size = statSize(ctx.temp);
            if (!size) return null;

            if (isLossy) {
                const threshold = Math.floor((size * (105 + Math.floor((100 - quality) / 2))) / 100);
                if (!(threshold < ctx.input.byteSize)) return null;
            }

            return { size, label: isLossy ? 'Giflossy' : label, lossy: isLossy };
        },
    };
}

const svgcleaner = {
    id: 'svgcleaner',
    exe: 'svgcleaner',
    label: 'Svgcleaner',
    types: [SVG],
    lossy: false,
    enabled: (s) => s.SvgcleanerEnabled,
    async run(ctx) {
        const args = ['--stdout', '--', ctx.input.path];
        const { code } = await run.runTool({
            exe: ctx.exe,
            args,
            stdoutPath: ctx.temp,
            signal: ctx.signal,
        });
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: 'Svgcleaner' };
    },
};

const svgo = {
    id: 'svgo',
    label: 'SVGO',
    script: 'svgo.js',
    types: [SVG],
    lossy: false,
    enabled: (s) => s.SvgoEnabled,
    async run(ctx) {
        // svgo.js is a webpack bundle, not an executable: lib/svgo.js runs it
        // in Electron's utility processes, so the installer ships no Node
        const { code } = await svgoRunner.optimize({
            script: ctx.script,
            lossy: Boolean(ctx.settings.LossyEnabled),
            input: ctx.input.path,
            output: ctx.temp,
            signal: ctx.signal,
        });
        if (code !== 0) return null;
        // The lossy plugin set rounds coordinates and drops titles
        return { size: statSize(ctx.temp), label: ctx.settings.LossyEnabled ? 'SVGO' : 'SVGO lite', lossy: Boolean(ctx.settings.LossyEnabled) };
    },
};

// ---------------------------------------------------------------- WebP, AVIF
//
// Neither format exists in the macOS app, so these command lines are this
// port's own. The measurements behind them are in win/README.md, "WebP and
// AVIF".

// A lossy re-encode has to save at least this much over the file it was given,
// as jpegoptim's lossy pass does, or it is not worth another generation of
// loss. It also stops Optimize Again from re-encoding the same file over and
// over for a percent each time.
const LOSSY_MIN_SAVING = 0.05;

function lossyWorthIt(ctx, size) {
    return size > 0 && size <= ctx.input.byteSize * (1 - LOSSY_MIN_SAVING);
}

// cwebp -z. 9 is where the gains are - a screenshot came out 41% smaller at 9
// against 3% at 7 - but on a 12-megapixel photo it took 22 seconds and saved
// nothing, where 7 took 6. A lossless WebP over 2 MB is a photograph more often
// than not, so it gets 7.
function webpLosslessEffort(level, byteSize) {
    if (level <= 2) return 6;
    return byteSize > 2 * 1024 * 1024 ? 7 : 9;
}

// cwebp's -mt is on or off, so it is left off only when this run has a
// single core to itself
function multiThread(ctx) {
    return ctx.threads === 1 ? [] : ['-mt'];
}

const cwebp = {
    id: 'cwebp',
    exe: 'cwebp',
    label: 'cwebp',
    types: [WEBP],
    lossy: false,
    enabled: (s) => s.CwebpEnabled,
    async run(ctx) {
        // -exact keeps the colour under fully transparent pixels, which
        // -lossless alone is allowed to change, so the pixels are identical.
        // -metadata icc copies the ICC profile across and drops EXIF and XMP.
        const args = [
            '-lossless', '-z', String(webpLosslessEffort(ctx.level, ctx.input.byteSize)),
            '-exact', ...multiThread(ctx),
            '-metadata', ctx.settings.WebPAvifStripMetadata ? 'icc' : 'all',
            '-quiet', '-o', ctx.temp, '--', ctx.input.path,
        ];
        const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: 'cwebp' };
    },
};

const cwebpLossy = {
    id: 'cwebp-lossy',
    exe: 'cwebp',
    label: 'cwebp',
    types: [WEBP],
    lossy: true,
    enabled: (s) => s.LossyEnabled && s.CwebpEnabled && s.WebPQuality < 100 && s.WebPQuality > 30,
    async run(ctx) {
        const quality = Number(ctx.settings.WebPQuality);
        const args = [
            '-q', String(quality), '-m', '6', ...multiThread(ctx),
            '-metadata', ctx.settings.WebPAvifStripMetadata ? 'icc' : 'all',
            '-quiet', '-o', ctx.temp, '--', ctx.input.path,
        ];
        const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;
        const size = statSize(ctx.temp);
        if (!lossyWorthIt(ctx, size)) return null;
        return { size, label: `cwebp ${quality}%`, lossy: true };
    },
};

// webpmux deletes one kind of chunk per run - two -strip options are an error -
// so EXIF and XMP take one run each, chained through a second temp file. Only
// the chunks the file actually has are asked for: asking for one that is not
// there fails with WEBP_MUX_NOT_FOUND and writes nothing.
const webpmux = {
    id: 'webpmux',
    exe: 'webpmux',
    label: 'webpmux',
    types: [WEBP],
    lossy: false,
    enabled: (s) => s.WebpmuxEnabled && s.WebPAvifStripMetadata,
    async run(ctx) {
        const features = ctx.features || {};
        const chunks = ['exif', 'xmp'].filter((chunk) => features[chunk]);
        if (!chunks.length) return null;

        let source = ctx.input.path;
        for (const [i, chunk] of chunks.entries()) {
            const out = i === chunks.length - 1 ? ctx.temp : `${ctx.temp}.${chunk}`;
            const args = ['-strip', chunk, '-o', out, '--', source];
            const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
            if (source !== ctx.input.path) unlinkQuietly(source);
            if (code !== 0) {
                unlinkQuietly(out);
                return null;
            }
            source = out;
        }
        return { size: statSize(ctx.temp), label: 'webpmux' };
    },
};

// What avifdec reports about the image it decoded, from the summary it prints.
function parseAvifdecSummary(output) {
    const field = (name) => {
        const match = new RegExp(`\\* ${name}\\s*: (.*)`).exec(output);
        return match ? match[1].trim() : null;
    };
    const format = /YUV(\d{3})/.exec(field('Format') || '');
    const clli = /^(\d+),\s*(\d+)$/.exec(field('CLLI') || '');
    return {
        depth: Number(field('Bit Depth')) || 0,
        format: format ? format[1] : null,
        gainMap: Boolean(field('Gain map')) && field('Gain map') !== 'Absent',
        clli: clli ? `${clli[1]},${clli[2]}` : null,
    };
}

// avifenc's -s for an effort level: 6, its own default, at the default level 4,
// down to 4 at 6 and above - about four times slower for another 4% (17% saved
// against 13% at 60). 7 to 8 at the low levels.
function avifSpeed(level) {
    return Math.max(4, Math.min(8, 10 - level));
}

// avifenc and avifdec use every core unless told otherwise. --autotiling would
// let more threads work on one image, but it splits the image into tiles,
// which costs a little size, so it is left alone.
function avifJobs(ctx) {
    return ctx.threads ? ['-j', String(ctx.threads)] : [];
}

// AVIF has no lossless optimizer, so this is a lossy re-encode and only runs
// with lossy minification on. avifenc cannot read AVIF, so avifdec decodes it
// first. The intermediate is PNG rather than y4m because PNG carries the ICC
// profile, Exif, XMP, alpha and the colour primaries and transfer across, where
// y4m keeps none of the metadata and drops alpha from 4:2:0 images. avifdec
// applies any rotation, mirroring and crop to the pixels as it writes, so the
// image looks the same. What PNG cannot say - the chroma subsampling, the bit
// depth, HDR content light levels - is read from avifdec's summary and passed
// to avifenc, or a 4:2:0 photo would come back as 4:4:4 and a 10-bit one as 12.
const avifenc = {
    id: 'avifenc',
    exe: 'avifenc',
    helpers: ['avifdec'],
    label: 'avifenc',
    types: [AVIF],
    lossy: true,
    enabled: (s) => s.LossyEnabled && s.AvifencEnabled && s.AvifQuality < 100 && s.AvifQuality > 30,
    async run(ctx) {
        const avifdec = ctx.helpers && ctx.helpers.avifdec;
        if (!avifdec) return null;

        // Uncompressed, since it only lives until avifenc has read it: a
        // 12-megapixel decode took 0.55 s like this and 3 s at the default.
        // 16-bit, so that a 10- or 12-bit image keeps its precision. --sato
        // decodes a sample-transform file whole, so that its summary says 16
        // bits rather than the 12 of the base image alone.
        const decoded = `${ctx.temp}.png`;
        try {
            const dec = await run.runTool({
                exe: avifdec,
                args: ['--sato', '--png-compress', '0', '-d', '16', ...avifJobs(ctx), '--', ctx.input.path, decoded],
                signal: ctx.signal,
            });
            if (dec.code !== 0) return null;

            const image = parseAvifdecSummary(dec.output);
            // A gain map would be lost, and avifenc encodes at most 12 bits
            if (image.gainMap || !image.format || !image.depth || image.depth > 12) return null;

            const quality = Number(ctx.settings.AvifQuality);
            const args = [
                '-q', String(quality),
                '-s', String(avifSpeed(ctx.level)),
                '-y', image.format,
                '-d', String(image.depth),
            ];
            if (image.clli) args.push('--clli', image.clli);
            if (ctx.settings.WebPAvifStripMetadata) args.push('--ignore-exif', '--ignore-xmp');
            args.push(...avifJobs(ctx));
            args.push('--', decoded, ctx.temp);

            const { code } = await run.runTool({ exe: ctx.exe, args, signal: ctx.signal });
            if (code !== 0) return null;
            const size = statSize(ctx.temp);
            if (!lossyWorthIt(ctx, size)) return null;
            return { size, label: `avifenc ${quality}%`, lossy: true };
        } finally {
            unlinkQuietly(decoded);
        }
    },
};

function unlinkQuietly(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch (err) {
        /* not there */
    }
}

// How long a tool may run on this input before it counts as hung. Generous on
// purpose: a run stopped early is a saving lost, while the point is only that
// a tool which never returns cannot hold its slot, and the batch, for ever.
const MB = 1024 * 1024;

function defaultTimeoutMs(byteSize) {
    return 60000 + 30000 * (byteSize / MB);
}

zopflipng.timeoutMs = (ctx) => {
    // Twice the longest --timelimit run() can pass (the alternative strategy
    // gets 1.4 times the formula), plus time to read and write the file
    const longest = (8 + ctx.level * 13) * 1.4 * 1000;
    return Math.max(defaultTimeoutMs(ctx.input.byteSize), 2 * longest + 10000);
};
// Minutes per megapixel; a JPEG holds a few megapixels per megabyte
guetzli.timeoutMs = (ctx) => Math.max(defaultTimeoutMs(ctx.input.byteSize), 180000 * (ctx.input.byteSize / MB));
// Decode and encode, at the slower speeds of the higher efforts
avifenc.timeoutMs = (ctx) => Math.max(defaultTimeoutMs(ctx.input.byteSize), 120000 + 120000 * (ctx.input.byteSize / MB));

function timeoutMs(tool, ctx) {
    return Math.round(tool.timeoutMs ? tool.timeoutMs(ctx) : defaultTimeoutMs(ctx.input.byteSize));
}

const ALL = [
    pngquant, pngcrush, oxipng, advpng, zopflipng,
    guetzli, jpegoptim, jpegtran,
    makeGifsicle(false), makeGifsicle(true),
    svgo, svgcleaner,
    webpmux, cwebpLossy, cwebp, avifenc,
];

module.exports = {
    ALL,
    byId: (id) => ALL.find((t) => t.id === id),
    statSize,
    timeoutMs,
    parseAvifdecSummary,
    webpLosslessEffort,
    avifSpeed,
};
