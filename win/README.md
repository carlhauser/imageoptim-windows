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

That writes `ImageOptim-Setup-<version>.exe`, its `.blockmap`, `latest.yml` and
`ImageOptim-<version>-win.zip`. It never publishes anything: releases are made
by CI from a version tag, as described under [Releasing](#releasing).

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

`test/updater.test.js` drives the update logic against a fake electron-updater,
so it needs neither the network nor the package installed: telling an install
from the unzipped copy, never restarting while the queue is busy, which checks
stay silent, the banner's wording, and the `package.json` settings the release
path depends on (a draft release or an installer name with a space in it would
each break updating without failing anything else).

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
`win/`, excluding markdown, because Windows runners bill at twice the rate. A
`v*` tag runs it too, and then it also publishes a GitHub Release; see
[Releasing](#releasing).

The first runs exposed faults that reading the script alone had not found:

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

Running it all on a Windows 11 machine, rather than only in CI, found four more:

- **The tests never ran on Windows.** npm runs scripts through `cmd.exe`, where
  single quotes are literal, so `node --test 'test/*.test.js'` matched nothing
  and passed with zero tests - including the CI step that was meant to check the
  real executables. The glob is now unquoted: `cmd.exe` hands it to Node, which
  expands it, and a POSIX shell expands it itself. Both CI test steps also fail
  if no tests ran, and the Windows one if any were skipped.
- **Release 1.4.0 shipped five optimizers that only ran by accident.** AdvPNG,
  Gifsicle, Guetzli, Pngcrush and Zopfli were linked against MinGW runtime DLLs
  (libstdc++, libgcc_s, winpthread, zlib1, libpng16) that are not shipped. They
  loaded wherever Git for Windows' `mingw64\bin` happened to be on PATH - the
  build machine, the CI runner - and failed with `0xC0000135` everywhere else,
  which the app reads as "no improvement". GIFs, whose only optimizer is
  Gifsicle, were never optimized. They are now linked with `-static`, and
  `Test-SelfContained` refuses to publish any executable that imports a DLL
  from MinGW's own `bin`.
- `build-windows.ps1` broke under Windows PowerShell 5.1, the one Windows ships.
  With output redirected, 5.1 turns a native command's stderr into terminating
  errors, so a pacman warning aborted the build; and it passes arguments with
  embedded double quotes unescaped, so a bash script containing `"` arrived in
  pieces. Bash now writes stderr to stdout, and scripts go to it as a file.
- The `queue` cycle test made a symlink, which Windows only allows with
  administrator rights or Developer Mode; it now makes a junction.

## Runtime

Electron 45.2.2 (Node 24, Chromium 156). Electron patches only its newest three
majors, so the version pinned here is kept current rather than left to age — the
previous pin, 33.2.0, was two years old and carried unpatched Chromium issues.

Verified by running the real preload, renderer and `lib/` under Electron 45 on
macOS: the contextBridge surface, `nativeImage` decoding for the Guetzli path, a
full optimize run, and the rendered rows and status bar. Since then also on
Windows 11, with optimizers built locally by `build-windows.ps1` and no MinGW
directory on PATH: the full test suite including the binary checks, and an
optimize run over PNG, JPEG, GIF and SVG samples with every result decoded
afterwards.

The page declares `color-scheme: light dark`, without which Chromium draws its
native controls - scrollbars, sliders, checkboxes, the select - in the light
scheme even in a dark window. Scrollbars use the standard `scrollbar-width` and
`scrollbar-color` rather than a Chromium feature switch: neither
`FluentOverlayScrollbar` nor `OverlayScrollbar` changes anything in Chromium 156.

The UI font is Inter, bundled in `renderer/fonts/` (from
`@fontsource-variable/inter`, SIL Open Font License, `OFL.txt` beside it) so the
app looks the same on machines without it installed; anything outside Inter's
scripts falls back to Segoe UI. The icons are Microsoft's Fluent UI System
Icons (MIT), copied into `renderer/icons/` and drawn as CSS masks so they take
the text or accent colour. The accent colour is a hue and saturation from
Settings → Appearance; `style.css` derives every shade from them in OKLCH at
fixed lightnesses, so text keeps its contrast whichever colour is picked. The
Theme setting there sets Electron's `nativeTheme.themeSource`, which drives
`prefers-color-scheme` in the page and the native controls alike.

The layout follows the window down to its 420 px minimum: toolbar labels give
way to icons (each button keeps an `aria-label` and a tooltip), the list drops
Best tool and then Size through container queries on its own width, and below
720 px the settings panel overlays the list instead of squeezing it.

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

## Updates

The app updates itself from this repository's GitHub Releases, through
electron-updater. The GitHub provider reads `releases.atom`, `latest.yml` and
the installer without credentials, so it needs the repository to stay public: a
private one answers all three with 404. `ENABLED` in `lib/updater.js` switches
the whole thing off - no check at startup, no **Check for Updates…** in the Help
menu, and electron-updater never loaded.

Copies installed from 1.4.2 or earlier were built with the updater off and never
check, so the first release with it on has to be installed by hand once.

### What it does

The packaged app checks for a newer release a few seconds after it starts, and
**Help → Check for Updates…** does the same on demand.

* **The installed copy** (`ImageOptim-Setup-<version>.exe`) downloads a newer
  version in the background, then shows a bar above the status bar with
  **Restart to Update**. Files are rewritten in place, so if any are queued or
  being optimized the restart waits until the queue is idle; the bar says so and
  can cancel. The restart is an ordinary quit - `before-quit` stops the queue
  and removes the session's backups, so Revert does not carry across an update,
  as it does not across any quit. **Later** leaves the update to install
  silently the next time the app quits.
* **The portable copy** (the zip) cannot replace its own files, so it only says
  that a new version exists and links to its release page. It is told apart
  from an install by the missing `Uninstall ImageOptim.exe` beside
  `ImageOptim.exe`: electron-builder sets `PORTABLE_EXECUTABLE_DIR` only for its
  `portable` target, which is a self-extracting exe, not for `zip`.
* **A checkout** (`npm start`) never checks.

A background check says nothing when there is no update or GitHub cannot be
reached; only a check you ask for reports "up to date" or an error. What the
updater does is logged to `%APPDATA%\ImageOptim\updater.log`. It takes the
newest release that is neither a draft nor a pre-release, needs `latest.yml` in
it, and fetches the installer by the name `latest.yml` gives.

### Unsigned updates

The app is not code-signed, and updating does not need it to be. The NSIS
updater checks an installer's Authenticode signature only when the installed
copy's `resources\app-update.yml` names a `publisherName`, and electron-builder
writes one only for a signed build; `win.verifyUpdateCodeSignature: false` in
`package.json` makes that explicit. The download is instead checked against the
sha512 in `latest.yml`, which comes over HTTPS from the same release - so anyone
who can publish a release on the repository can ship code to every installed
copy, and write access to it should be treated accordingly.

The updater downloads with Electron's own network stack, so the installer has
no mark of the web and SmartScreen does not stop it; the blue "Windows protected
your PC" box is only for the first install, from a browser.

If the app is signed later, drop `verifyUpdateCodeSignature: false`. Copies
installed from then on accept only updates signed by the same publisher.

## Releasing

1. Set the new version in `win/package.json` and its lock file:

   ```sh
   cd win && npm version 1.5.0 --no-git-tag-version
   ```

2. Commit that, then tag the commit and push both:

   ```sh
   git tag v1.5.0
   ```

   ```sh
   git push origin main v1.5.0
   ```

3. The tag starts `.github/workflows/windows.yml`. It refuses a tag that does
   not match `package.json` before compiling anything, builds every optimizer
   and the app, runs the tests including the binary checks (failing if none ran
   or any were skipped), and then the `release` job publishes GitHub Release
   `v1.5.0` with:

   | file | for |
   | --- | --- |
   | `ImageOptim-Setup-1.5.0.exe` | the installer |
   | `ImageOptim-1.5.0-win.zip` | the portable copy |
   | `ImageOptim-Setup-1.5.0.exe.blockmap` | for the updater: differential downloads |
   | `latest.yml` | for the updater: version, file name, sha512 |

   Release notes are generated from the commits since the previous tag and can
   be edited on GitHub afterwards. Installed copies pick the release up by
   themselves within a few seconds of their next start.

The push to `main` starts a second Windows build of the same commit, because
`win/package.json` changed. Only the tag's run publishes anything, so the other
can be cancelled from the Actions tab to save the minutes.

A release is published only when every job succeeded. The packaging job still
runs after a partial optimizer build, so its artifacts can be inspected, but a
release with missing optimizers is not something to hand out - least of all
once the updater is on and installed copies take releases unattended.
Re-running the workflow for a tag replaces that release's files rather than
failing. The updater never downgrades, so a bad release is fixed by releasing a
higher version.

The installer is named without spaces (`nsis.artifactName`). GitHub turns spaces
in asset names into dots while `latest.yml` names a dashed copy, so an
`ImageOptim Setup 1.5.0.exe` uploaded as it is would never be found.
`npm run dist:win` passes `--publish never` because electron-builder otherwise
publishes by itself whenever it sees a tag on CI; uploading is left to the
release job alone.

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
  lib/updater.js        the self-updater: see Updates
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
