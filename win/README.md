# ImageOptim for Windows

A Windows front-end for the optimizers that ImageOptim drives, plus a script that
builds those optimizers with MinGW-w64.

The macOS app is Cocoa and does not port, but every optimizer it runs is portable
C, C++, Rust or JavaScript. This directory holds an Electron app that queues
images, runs the same optimizers with the same command lines, keeps whichever
output is smallest, and overwrites the original in place.

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
  lib/settings.js       defaults ported from imageoptim/defaults.plist
  lib/run.js            child process plumbing and output parsing
  lib/tools.js          one entry per optimizer, with its exact arguments
  lib/job.js            per-image plan, execution and saving
  lib/queue.js          folder scanning, concurrency, totals
  renderer/             the window itself
  resources/bin/        the built executables (created by the build script)
```

## Development without Windows binaries

`IMAGEOPTIM_BIN` overrides where the optimizers are looked up, which is enough to
drive `lib/` against any existing set of binaries:

```sh
IMAGEOPTIM_BIN=/path/to/binaries npm start
```

The resolver expects `<IMAGEOPTIM_BIN>/<tool>.exe` on Windows, `<tool>` elsewhere,
and `svgo.js` in the parent directory.
