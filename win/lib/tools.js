'use strict';

const fs = require('fs');
const path = require('path');
const { runTool, numberAfter, firstTwoNumbers } = require('./run');
const { PNG, JPEG, GIF, SVG, isSmall, isLarge } = require('./filetype');

// One entry per optimizer, ported from imageoptim/Backend/Workers/*.m. The
// command lines are deliberately identical to the macOS app's: these flags are
// the result of years of tuning and of working around decoder bugs (gifsicle's
// --careful, pngcrush's 70-byte truncated output, jpegoptim's 5% lossy floor).
//
// A tool's run() writes a candidate file to ctx.temp and returns its size, or
// null when it produced nothing useful. Deciding whether to keep the candidate
// belongs to the job, which keeps whichever output is smallest.

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

        const { code } = await runTool({ exe: ctx.exe, args, signal: ctx.signal });
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
        const speed = Math.min(3, 7 - ctx.level);

        const args = [
            '256', '--skip-if-larger',
            `-s${speed}`,
            '--quality', `${minQuality}-${maxQuality}`,
            '-',
        ];

        const { code } = await runTool({
            exe: ctx.exe,
            args,
            stdinPath: ctx.input.path,
            stdoutPath: ctx.temp,
            signal: ctx.signal,
        });

        // 98 = output was not smaller, 99 = quality floor not reachable. Both are
        // pngquant declining the image, not an error.
        if (code === 98 || code === 99) return null;
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: 'pngquant' };
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

        let actualIterations = iterations;
        let filters = '--filters=0pme';

        if (isLarge(ctx.input.type, ctx.input.byteSize)) {
            actualIterations = 5 + Math.floor(actualIterations / 3);
            filters = '--filters=p';
        }

        if (ctx.alternativeStrategy) {
            timelimit *= 1.4;
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

        const { code } = await runTool({ exe: ctx.exe, args, signal: ctx.signal });
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
        fs.copyFileSync(ctx.input.path, ctx.temp); // advpng rewrites in place

        const args = [`-${level}`, '-z', '--', ctx.temp];
        const { code, output } = await runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;

        const numbers = firstTwoNumbers(output);
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

        const { code } = await runTool({ exe: ctx.exe, args, signal: ctx.signal });
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

        fs.copyFileSync(ctx.input.path, ctx.temp); // jpegoptim rewrites in place

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

        const { output } = await runTool({ exe: ctx.exe, args, signal: ctx.signal });
        const reported = numberAfter(output, ' --> ');
        if (!reported || reported !== statSize(ctx.temp)) return null;

        if (lossy && !(ctx.input.byteSize * 0.95 > reported)) {
            return null; // demand at least 5% for a lossy pass
        }

        return { size: reported, label: lossy ? `JpegOptim ${maxquality}%` : 'JpegOptim' };
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
        const { code } = await runTool({
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
    serial: true, // Guetzli's memory use makes parallel runs dangerous
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

        const { code } = await runTool({ exe: ctx.exe, args, signal: ctx.signal });
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: 'Guetzli' };
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

            const { code } = await runTool({ exe: ctx.exe, args, signal: ctx.signal });
            if (code !== 0) return null;

            const size = statSize(ctx.temp);
            if (!size) return null;

            if (isLossy) {
                const threshold = Math.floor((size * (105 + Math.floor((100 - quality) / 2))) / 100);
                if (!(threshold < ctx.input.byteSize)) return null;
            }

            return { size, label: isLossy ? 'Giflossy' : label };
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
        const { code } = await runTool({
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
        // svgo.js is a webpack bundle, not an executable. Electron's own binary
        // runs it as Node when ELECTRON_RUN_AS_NODE is set, so the installer does
        // not have to ship a separate Node runtime.
        const lossy = ctx.settings.LossyEnabled ? '1' : '0';
        const { code } = await runTool({
            exe: process.execPath,
            args: [ctx.script, lossy, ctx.input.path, ctx.temp],
            signal: ctx.signal,
            env: { ELECTRON_RUN_AS_NODE: '1' },
        });
        if (code !== 0) return null;
        return { size: statSize(ctx.temp), label: ctx.settings.LossyEnabled ? 'SVGO' : 'SVGO lite' };
    },
};

const ALL = [
    pngquant, pngcrush, oxipng, advpng, zopflipng,
    guetzli, jpegoptim, jpegtran,
    makeGifsicle(false), makeGifsicle(true),
    svgo, svgcleaner,
];

module.exports = {
    ALL,
    byId: (id) => ALL.find((t) => t.id === id),
    statSize,
};
