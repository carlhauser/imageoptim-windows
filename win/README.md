# ImageOptim for Windows

A Windows front-end for the optimizers that ImageOptim drives, plus a script that
builds those optimizers with MinGW-w64.

The macOS app is Cocoa and does not port, but every optimizer it runs is portable
C, C++, Rust or JavaScript. This directory holds an Electron app that queues
images, runs the same optimizers with the same command lines, keeps whichever
output is smallest, and overwrites the original in place.

![ImageOptim running on a folder of mixed images](../docs/screenshots/results-light.png)

## Building

### 1. The optimizer executables

Run from a PowerShell prompt at the repository root, on Windows:

```powershell
.\build-windows.ps1
```

It needs [MSYS2](https://www.msys2.org/) (`winget install -e --id MSYS2.MSYS2`),
installs the MinGW-w64 toolchain, CMake, Ninja, NASM, zlib, libpng and gflags
through `pacman`, and writes the results to `win\resources\bin`.

Rust comes from `rustup` when it is on PATH, otherwise from the MSYS2 package.
Either way the Rust tools are built for `x86_64-pc-windows-gnu`, so the whole
`bin` directory shares one ABI.

Useful flags:

```powershell
.\build-windows.ps1 -Only oxipng,pngquant -SkipBootstrap
```

```powershell
.\build-windows.ps1 -Clean -Jobs 8
```

A tool that fails to build is reported in the summary and the script carries on;
the front-end skips optimizers whose executable is absent, so a partial build
still runs with fewer optimizers.

### 2. The application

```powershell
cd win
npm install
npm start
```

To produce an installer and a portable zip in `win\dist`:

```powershell
npm run dist:win
```

`extraResources` copies `win\resources` into the packaged app, so the installer
carries the executables built in step 1.

## What runs on which format

The plan for each image is a port of `doEnqueueWorkersInCPUQueue` in
`imageoptim/Backend/Job.m`, and the command lines come from
`imageoptim/Backend/Workers/*.m`.

| Format | Optimizers |
| ------ | ---------- |
| PNG | pngquant (lossy), Pngcrush, OxiPNG, AdvPNG, Zopfli |
| JPEG | Guetzli (lossy), JpegOptim, MozJPEG (jpegtran) |
| GIF | Gifsicle, Giflossy (lossy) |
| SVG | SVGO, Svgcleaner |

Optimizers that rewrite an image rather than merely recompressing it run first
and one at a time, so the rest see their output. The lossless ones then run in
parallel against that result, and the smallest output wins. A file that no tool
improved is left exactly as it was.

## Performance

Zopfli dominates the cost of a PNG run and, on anything photographic, loses to
OxiPNG anyway. Measured on this machine, one 2 MB PNG:

| optimizer | result | time |
| --------- | ------ | ---- |
| OxiPNG `-o4` | 1,354,628 B | 3.2s |
| Zopfli, 1 iteration | 1,428,213 B | 42.6s |
| Zopfli, 10 iterations | 1,389,170 B | 55.7s |

OxiPNG won at every size tested from 177 KB to 2 MB, between twenty and sixty
times faster. Capping Zopfli's `--timelimit` does not help, because it only
checks the clock between iterations and a single iteration on a large image
already overruns any sensible budget.

So `ZopfliSkipAboveKB` (default 256) skips Zopfli once a file is bigger than
that, which is ImageOptim's own threshold for a "large" PNG. Below it Zopfli is
cheap and does sometimes win, so it still runs. Over thirty photos:

| | time | saved |
| --- | --- | --- |
| default | 9.8s | 28.27% |
| `ThoroughPng: true` | 127.8s | 28.27% |

Thirteen times faster for 714 bytes out of 8.7 MB. `ThoroughPng` restores the
macOS behaviour exactly: no size threshold and no time budget.

`QueueOrder` decides which file is picked up next: `smallest` (the default) so
the list fills with finished rows quickly rather than appearing stuck on one
large image, `largest` so the slowest file is not left running alone at the end,
or `added` to keep drop order. Only files that have not started are reordered.

`MaxWorkers` caps how many optimizer processes run at once across every file.
Without a global cap the two limits multiply - files in flight times optimizers
per file - and oversubscribe the machine. Measured over thirty photos on a
16-core machine: 2 workers 27.0s, 4 workers 15.0s, 8 workers 12.0s, 16 workers
12.6s. The default is the core count capped at eight.

## Tests

```sh
cd win && npm test
```

No dependencies: `node:test` with the optimizers stubbed, so nothing is spawned.
74 tests across four areas.

`test/arguments.test.js` is the one that matters most. Every optimizer's command
line is asserted against the macOS worker it was ported from, with the
expectations taken from `imageoptim/Backend/Workers/*.m` rather than from
`lib/tools.js`, so a drift in the port fails rather than being blessed. A wrong
flag does not raise an error anywhere: the tool exits non-zero, the job reads
that as "no improvement", and a broken optimizer is indistinguishable from an
already-optimal file.

`test/plan.test.js` covers which optimizers each format gets and in which group,
`test/queue.test.js` covers folder scanning and queue order, and
`test/job.test.js` covers the parts that can destroy a file: adopting a result,
the atomic replace, the staleness refusals and revert.

Stubbed tests cannot prove the optimizers *accept* those arguments.
`test/binaries.test.js` does, by running the real executables; it is skipped
unless a directory of them is given:

```sh
cd win && IMAGEOPTIM_BIN=/path/to/bin npm test
```

CI runs the stubbed suite on Linux for every push to `win/`, and the binary
checks on Windows against the executables each build has just produced.

## Continuous integration

`.github/workflows/windows.yml` builds every optimizer from the sources in this
repository on a `windows-latest` runner, then packages the app around them with
electron-builder. It runs on demand and on changes to `build-windows.ps1` or
`win/`, excluding markdown, because Windows runners bill at twice the rate.

Getting it green took six runs and exposed faults that no amount of reading the
script on macOS would have found:

- `pacman -Syu` terminates its own shell after replacing `msys2-runtime`, so a
  `||` fallback in the same command never executes.
- `gifsicle/orig/.gitignore` contains `include` and
  `zopfli-png/zopfli/.gitignore` contains `zopflipng`; both are build-output
  names that collide with source directories, so those sources had never been
  committed. They built locally only because the files existed on disk.
- MozJPEG and libpng declare a `cmake_minimum_required` that CMake 4 rejects.
- ImageOptim's zopfli fork evaluates filter strategies through Grand Central
  Dispatch, which is macOS-only and uses clang block syntax; the call is now
  behind `__APPLE__` with a serial loop elsewhere.
- jpegoptim's CMakeLists globs every `*.c`, pulling in a vendored GNU getopt
  that needs autotools feature macros, and its `win32_compat.h` aliases `lstat`
  to `_stat`, which on MinGW-w64 expands to `_stat64i32` and takes a different
  struct than `misc.c` passes.
- AdvanceCOMP 1.15 declares `throw()` specifications that C++17 removed.
- `svgo.js` is not an executable, so it sat outside the `bin/` artifact path and
  never reached the packaging job. The app shipped with no SVGO and reported
  nothing, because a missing optimizer is skipped by design. The packaging job
  now fails if it is absent.

## Runtime

Electron 45.2.2 (Node 24, Chromium 156). Electron patches only its newest three
majors, so the version pinned here is kept current rather than left to age — the
previous pin, 33.2.0, was two years old and carried unpatched Chromium issues.

Verified by running the real preload, renderer and `lib/` under Electron 45 on
macOS: the contextBridge surface, `nativeImage` decoding for the Guetzli path, a
full optimize run, and the rendered rows and status bar.

## Saving safely

The optimized result is staged beside the original and renamed onto it, which is
atomic on NTFS, so an interrupted save leaves either the old file or the new one
and never a truncated image. Before writing, the file is re-checked against the
size and modification time it had when the optimizers started: if another program
changed it in the meantime the save is refused, because the result was derived
from the old bytes and the backup would be of the old bytes too.

Each original is copied to a scratch directory before being replaced, and Revert
restores from there through the same atomic path. That directory is created with
`mkdtemp`, swept at startup and removed at quit, and a job's backup is deleted
when it leaves the list.

## Differences from the macOS app

* **No PNGOUT.** It is a closed-source binary that ImageOptim downloads
  separately on macOS, and it is not redistributable here.
* **Guetzli is off by default.** It takes minutes and gigabytes of RAM per
  image. The macOS app converts its input to sRGB through ColorSync first;
  Electron's `nativeImage` has no colour-management entry point, so an image
  carrying an unusual ICC profile may shift slightly.
* **`PreservePermissions` only syncs the Unix mode bits.** Windows permissions
  live in the ACL, which survives the in-place write untouched.
* **No results database.** The macOS app remembers hashes of files it has
  already optimized across launches; here that memory lasts for the session.
* **Revert** keeps a copy of each original in the temp directory for the
  lifetime of the session, so it does not depend on the Recycle Bin.

## Using it

Drop files or folders onto the window, or use Add Files / Add Folder. Folders are
scanned recursively for PNG, JPEG, GIF and SVG.

| | |
| --- | --- |
| Double-click a row | show the file in Explorer |
| Delete | remove the selected rows from the list |
| Ctrl+Z | revert the selected files to their originals |
| Ctrl+R | optimize everything again, one effort level higher |
| Ctrl+. | stop |

Files are overwritten in place. Keep a copy of anything you cannot regenerate.

## Layout

```
build-windows.ps1       builds the optimizers (repository root)
win/
  main.js               window, menu, IPC, queue wiring
  preload.js            the renderer's only bridge to the main process
  lib/filetype.js       header sniffing and the small/large thresholds
  lib/semaphore.js      the global cap on concurrent optimizer processes
  lib/settings.js       defaults ported from imageoptim/defaults.plist
  lib/run.js            child process plumbing and output parsing
  lib/tools.js          one entry per optimizer, with its exact arguments
  lib/job.js            per-image plan, execution and saving
  lib/queue.js          folder scanning, concurrency, totals
  renderer/             the window itself
  resources/bin/        the built executables (created by the build script)
  resources/icon.ico    app icon, converted from imageoptim/ImageOptim.icns
```

## Development without Windows binaries

`IMAGEOPTIM_BIN` overrides where the optimizers are looked up, which is enough to
drive `lib/` against any existing set of binaries:

```sh
IMAGEOPTIM_BIN=/path/to/binaries npm start
```

The resolver expects `<IMAGEOPTIM_BIN>/<tool>.exe` on Windows, `<tool>` elsewhere,
and `svgo.js` in the parent directory.
