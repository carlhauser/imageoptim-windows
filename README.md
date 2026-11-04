# ImageOptim

[ImageOptim](https://imageoptim.com) is a GUI for lossless image optimization tools: Zopfli, PNGOUT, [OxiPNG](https://lib.rs/crates/oxipng), AdvPNG, PNGCrush, [JPEGOptim](https://github.com/tjko/jpegoptim), Jpegtran, [Guetzli](https://github.com/google/guetzli), [Gifsicle](https://kornel.ski/lossygif), [SVGO](https://github.com/svg/svgo), [svgcleaner](https://github.com/RazrFalcon/svgcleaner) and [MozJPEG](https://github.com/mozilla/mozjpeg).

This fork adds a **Windows port**. The macOS app's window is Cocoa and does not
translate, but every optimizer it drives is portable, so `win/` contains a
replacement front-end that runs them with the same per-format plans and the same
command-line arguments.

---

## ImageOptim for Windows

Drop files or folders in; each image is optimized in place and the smallest
result of every applicable optimizer is kept.

![The file list after a run, showing per-file savings and which optimizer won](docs/screenshots/results-light.png)

Light and dark follow the system setting.

![The same list in dark mode](docs/screenshots/results-dark.png)

Settings turns individual optimizers on and off, controls lossy quality per
format, and lists which optimizers are actually installed.

![The settings panel, showing the optimizer list and quality sliders](docs/screenshots/settings-dark.png)

### Download

From [Releases](https://github.com/carlhauser/imageoptim-windows/releases),
either `ImageOptim-Setup-<version>.exe` to install, or
`ImageOptim-<version>-win.zip` to unzip anywhere and run `ImageOptim.exe` with
nothing installed.

Both are built on a Windows machine in CI, with every optimizer compiled from
the sources in this repository.

The installed app keeps itself up to date: when a newer release is published it
downloads it in the background and offers **Restart to Update**, waiting if
files are being optimized (**Help → Check for Updates…** checks straight away).
The zip can't replace its own files, so it only tells you a new version is out.
Releases up to 1.4.1 predate the updater, so install the next one by hand.

The app is not code-signed, so Windows shows a blue "Windows protected your PC"
box on first launch — **More info** → **Run anyway**. Unblocking the zip before
extracting avoids it. Updates install without it: the updater checks each
download against the checksum published with the release.

**Files are replaced in place.** Saving is atomic — the result is staged beside
the original and renamed onto it — and each original is backed up for the session
so Ctrl+Z can restore it, but keep copies of anything irreplaceable.

### Building it yourself

`build-windows.ps1` compiles the optimizers from the sources in this repository
with MinGW-w64 under MSYS2, and `win/` packages the app around them. See
[`win/README.md`](win/README.md) for the detail, including how the optimizer
plans and the Zopfli size threshold were derived.

The screenshots above were taken on Windows 11 from a real run, and were
themselves optimized by this build: 37.1% smaller, Zopfli winning all three.

---

## Building the macOS app

Requires:

* Xcode
* [Rust](https://rust-lang.org/) installed via [rustup](https://www.rustup.rs/) (not Homebrew).

```sh
git clone --recursive https://imageoptim.com ImageOptim
cd ImageOptim
```

To get started, open `imageoptim/ImageOptim.xcodeproj`. It will automatically download and build all subprojects when run in Xcode.

In case of build errors, these sometimes help:

```sh
git submodule update --init
```

```sh
cd gifsicle # or pngquant
make clean
make
```
