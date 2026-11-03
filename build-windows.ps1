<#
.SYNOPSIS
    Builds the ImageOptim optimizer command-line tools for Windows (x64).

.DESCRIPTION
    ImageOptim's GUI is a macOS/Cocoa application and is not portable, but every
    optimizer it drives is portable C, C++, Rust or JavaScript. This script builds
    those optimizers with the MinGW-w64 toolchain inside MSYS2 and drops the
    resulting executables into win\resources\bin, where the Windows front-end in
    win\ looks for them.

    Tools built:
      libpng      libpng          libpng             (CMake, linked by pngcrush)
      jpegtran    MozJPEG         libjpeg/src        (CMake)
      jpegoptim   jpegoptim       jpegoptim/src      (CMake, links MozJPEG)
      advpng      AdvanceCOMP     advpng             (autotools)
      gifsicle    Giflossy        gifsicle/gifsicle  (autotools, patched copy)
      zopflipng   Zopfli          zopfli-png/zopfli  (make)
      pngcrush    pngcrush        pngcrush           (direct gcc, links libpng)
      guetzli     Guetzli         guetzli/guetzli    (make, needs libpng + gflags)
      oxipng      OxiPNG          oxipng/oxipng      (cargo)
      pngquant    pngquant        pngquant/src       (cargo, statically linked)
      svgcleaner  svgcleaner      svgcleaner/src     (cargo)
      svgo.js     SVGO            svgo/build         (prebuilt bundle, copied)

    PNGOUT is deliberately absent: it is a closed-source binary that ImageOptim
    downloads at runtime on macOS and is not redistributable here.

.PARAMETER MsysRoot
    MSYS2 installation directory. Default: C:\msys64

.PARAMETER OutDir
    Where to place the built executables. Default: win\resources\bin

.PARAMETER Only
    Build just these tools, e.g. -Only oxipng,pngquant. Default: all of them.

.PARAMETER SkipBootstrap
    Do not run pacman; assume the MSYS2 packages are already installed.

.PARAMETER Jobs
    Parallel make/ninja jobs. Default: the number of logical processors.

.PARAMETER Clean
    Delete the intermediate build directory before starting.

.EXAMPLE
    .\build-windows.ps1

.EXAMPLE
    .\build-windows.ps1 -Only oxipng,pngquant,svgcleaner -SkipBootstrap
#>

[CmdletBinding()]
param(
    [string]   $MsysRoot = 'C:\msys64',
    [string]   $OutDir   = '',
    [string[]] $Only     = @(),
    [switch]   $SkipBootstrap,
    [int]      $Jobs     = 0,
    [switch]   $Clean
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $RepoRoot 'win\resources\bin' }
$BuildDir = Join-Path $RepoRoot '.build-win'
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }

$AllTools = @(
    'libpng', 'mozjpeg', 'jpegoptim', 'advpng', 'gifsicle', 'zopflipng',
    'pngcrush', 'guetzli', 'oxipng', 'pngquant', 'svgcleaner', 'svgo'
)

# jpegoptim links against the MozJPEG static library, so asking for jpegoptim
# alone has to pull MozJPEG in with it.
$Targets = if ($Only.Count) { $Only } else { $AllTools }
if (($Targets -contains 'jpegoptim') -and -not ($Targets -contains 'mozjpeg')) {
    $Targets = @('mozjpeg') + $Targets
}
if (($Targets -contains 'pngcrush') -and -not ($Targets -contains 'libpng')) {
    $Targets = @('libpng') + $Targets
}
foreach ($t in $Targets) {
    if ($AllTools -notcontains $t) {
        throw "Unknown tool '$t'. Known tools: $($AllTools -join ', ')"
    }
}

$Results = [ordered]@{}

# ---------------------------------------------------------------- MSYS2 plumbing

$Bash = Join-Path $MsysRoot 'usr\bin\bash.exe'

function Assert-Msys2 {
    if (-not (Test-Path $Bash)) {
        throw @"
MSYS2 not found at $MsysRoot.

Install it, then re-run this script:

    winget install -e --id MSYS2.MSYS2

or download the installer from https://www.msys2.org/ and pass -MsysRoot if you
installed it somewhere other than C:\msys64.
"@
    }
}

# Runs a command in the MINGW64 environment. Returns the exit code; never throws,
# so one failing tool does not abort the whole run.
function Invoke-Mingw {
    param(
        [Parameter(Mandatory)] [string] $Script,
        [string] $WorkingDirectory = $RepoRoot
    )

    $msysCwd = ConvertTo-MsysPath $WorkingDirectory
    $full    = "set -euo pipefail; cd '$msysCwd'; $Script"

    $env:MSYSTEM        = 'MINGW64'
    $env:CHERE_INVOKING = '1'
    # Keep the Windows PATH visible so rustup, cargo and node stay reachable.
    $env:MSYS2_PATH_TYPE = 'inherit'

    # Send the build log straight to the console; otherwise it joins this
    # function's output stream and the caller gets an array instead of a code.
    & $Bash -lc $full | Out-Host
    return $LASTEXITCODE
}

function ConvertTo-MsysPath {
    param([Parameter(Mandatory)] [string] $Path)
    $p = $Path -replace '\\', '/'
    if ($p -match '^([A-Za-z]):/(.*)$') {
        return "/$($Matches[1].ToLower())/$($Matches[2])"
    }
    return $p
}

function Invoke-Step {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Script,
        [string] $WorkingDirectory = $RepoRoot
    )

    Write-Host ""
    Write-Host "==> $Name" -ForegroundColor Cyan
    $code = Invoke-Mingw -Script $Script -WorkingDirectory $WorkingDirectory
    if ($code -ne 0) {
        Write-Host "    $Name failed (exit $code)" -ForegroundColor Red
    }
    return $code
}

# Copies a built artifact into $OutDir, adding the .exe suffix when the build
# produced an extension-less binary (GNU make does that for hand-written rules).
function Publish-Artifact {
    param(
        [Parameter(Mandatory)] [string]   $Tool,
        [Parameter(Mandatory)] [string[]] $Candidates,
        [Parameter(Mandatory)] [string]   $TargetName
    )

    foreach ($rel in $Candidates) {
        $src = Join-Path $RepoRoot $rel
        if (Test-Path $src -PathType Leaf) {
            $dst = Join-Path $OutDir $TargetName
            Copy-Item -LiteralPath $src -Destination $dst -Force
            $size = [math]::Round((Get-Item $dst).Length / 1KB)
            Write-Host "    $TargetName  ($size KB)" -ForegroundColor Green
            $Results[$Tool] = 'built'
            return $true
        }
    }

    Write-Host "    could not find a built binary for $Tool" -ForegroundColor Red
    Write-Host "    looked for: $($Candidates -join ', ')" -ForegroundColor DarkGray
    $Results[$Tool] = 'FAILED'
    return $false
}

# ------------------------------------------------------------------- bootstrap

function Install-Dependencies {
    $packages = @(
        'base-devel', 'autoconf', 'automake', 'libtool', 'patch', 'git',
        'mingw-w64-x86_64-toolchain',
        'mingw-w64-x86_64-cmake',
        'mingw-w64-x86_64-ninja',
        'mingw-w64-x86_64-nasm',
        'mingw-w64-x86_64-pkgconf',
        'mingw-w64-x86_64-zlib',
        'mingw-w64-x86_64-libpng',
        'mingw-w64-x86_64-gflags'
    ) -join ' '

    $code = Invoke-Step -Name 'Installing MSYS2 build dependencies' -Script @"
pacman -Sy --noconfirm --needed $packages
"@
    if ($code -ne 0) { throw 'pacman failed; fix the package installation and re-run.' }
}

# Rust: prefer the user's rustup (newer compiler), fall back to MSYS2's package.
# Everything else here is MinGW, so Rust must target x86_64-pc-windows-gnu to
# keep one ABI across the whole bin directory.
function Resolve-Cargo {
    $rustup = Get-Command rustup -ErrorAction SilentlyContinue
    if ($rustup) {
        Write-Host "    using rustup at $($rustup.Source)" -ForegroundColor DarkGray
        & rustup target add x86_64-pc-windows-gnu | Out-Null
        return 'cargo'
    }

    Write-Host '    rustup not found; installing MSYS2 Rust' -ForegroundColor DarkGray
    $code = Invoke-Mingw -Script 'pacman -S --noconfirm --needed mingw-w64-x86_64-rust'
    if ($code -ne 0) {
        throw @"
No Rust toolchain available. Install rustup from https://rustup.rs/ (then run
'rustup target add x86_64-pc-windows-gnu'), or let pacman install
mingw-w64-x86_64-rust, and re-run this script.
"@
    }
    return 'cargo'
}

# ----------------------------------------------------------------- tool builds

function Build-LibPng {
    # pngcrush is compiled against this, exactly as the macOS Xcode target does
    # (its HEADER_SEARCH_PATHS is $(SRCROOT)/../libpng/). Using the repository's
    # own libpng rather than the one from pacman keeps the configuration - which
    # chunks and transforms are compiled in - identical on both platforms.
    $code = Invoke-Step -Name 'libpng (static, for pngcrush)' -Script @"
cmake -G Ninja -S libpng -B .build-win/libpng \
    -DCMAKE_BUILD_TYPE=Release \
    -DPNG_SHARED=OFF \
    -DPNG_STATIC=ON \
    -DPNG_TOOLS=OFF \
    -DPNG_TESTS=OFF
cmake --build .build-win/libpng --parallel $Jobs
"@
    if ($code -ne 0) { $Results['libpng'] = 'FAILED'; return }

    $lib = Get-ChildItem (Join-Path $RepoRoot '.build-win\libpng') -Filter 'libpng*.a' -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if (-not $lib) {
        Write-Host '    libpng built but no static library was found' -ForegroundColor Red
        $Results['libpng'] = 'FAILED'
        return
    }

    Write-Host "    $($lib.Name)" -ForegroundColor Green
    $Results['libpng'] = 'built'
}

function Build-MozJpeg {
    # Builds both jpegtran (a tool the GUI runs) and libjpeg.a (jpegoptim links it).
    $code = Invoke-Step -Name 'MozJPEG (jpegtran, libjpeg.a)' -Script @"
cmake -G Ninja -S libjpeg/src -B .build-win/mozjpeg \
    -DCMAKE_BUILD_TYPE=Release \
    -DENABLE_SHARED=FALSE \
    -DENABLE_STATIC=TRUE \
    -DPNG_SUPPORTED=FALSE \
    -DWITH_TURBOJPEG=FALSE
cmake --build .build-win/mozjpeg --parallel $Jobs
"@
    if ($code -ne 0) { $Results['mozjpeg'] = 'FAILED'; return }

    Publish-Artifact -Tool 'mozjpeg' -TargetName 'jpegtran.exe' -Candidates @(
        '.build-win/mozjpeg/jpegtran-static.exe',
        '.build-win/mozjpeg/jpegtran.exe'
    ) | Out-Null
}

function Build-Jpegoptim {
    # jpegoptim's CMakeLists declares cmake_minimum_required(VERSION 2.8), which
    # CMake 4 refuses outright, hence CMAKE_POLICY_VERSION_MINIMUM.
    $lib = (Join-Path $RepoRoot '.build-win\mozjpeg\libjpeg.a')
    if (-not (Test-Path $lib)) {
        $found = Get-ChildItem (Join-Path $RepoRoot '.build-win\mozjpeg') -Filter 'libjpeg*.a' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $lib = $found.FullName }
    }
    if (-not (Test-Path $lib)) {
        Write-Host '==> jpegoptim' -ForegroundColor Cyan
        Write-Host '    skipped: MozJPEG static library not built' -ForegroundColor Red
        $Results['jpegoptim'] = 'FAILED'
        return
    }

    $incJpeg  = ConvertTo-MsysPath (Join-Path $RepoRoot 'libjpeg\src')
    $incBuild = ConvertTo-MsysPath (Join-Path $RepoRoot '.build-win\mozjpeg')
    $libMsys  = ConvertTo-MsysPath $lib

    $code = Invoke-Step -Name 'jpegoptim' -Script @"
cmake -G Ninja -S jpegoptim/src -B .build-win/jpegoptim \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DLIBJPEG_INCLUDE_DIR='$incJpeg;$incBuild' \
    -DLIBJPEG_LIBRARY_DIR='$libMsys'
cmake --build .build-win/jpegoptim --parallel $Jobs
"@
    if ($code -ne 0) { $Results['jpegoptim'] = 'FAILED'; return }

    Publish-Artifact -Tool 'jpegoptim' -TargetName 'jpegoptim.exe' -Candidates @(
        '.build-win/jpegoptim/jpegoptim.exe'
    ) | Out-Null
}

function Build-AdvPng {
    $code = Invoke-Step -Name 'AdvPNG' -Script @"
if [ ! -f configure ]; then ./autogen.sh; fi
# A Makefile is already here - ImageOptim's own stub, which only unpacks the
# source tarball - so config.status is what says whether configure has run.
if [ ! -f config.status ]; then
    ./configure --disable-dependency-tracking CFLAGS='-O2' CXXFLAGS='-O2'
fi
make -j$Jobs advpng
"@ -WorkingDirectory (Join-Path $RepoRoot 'advpng')
    if ($code -ne 0) { $Results['advpng'] = 'FAILED'; return }

    Publish-Artifact -Tool 'advpng' -TargetName 'advpng.exe' -Candidates @(
        'advpng/advpng.exe', 'advpng/advpng'
    ) | Out-Null
}

function Build-Gifsicle {
    # ImageOptim runs Giflossy: upstream gifsicle plus a lossy-compression patch.
    # The patched copy is created by the macOS makefile, so create it here too
    # when it is missing.
    $code = Invoke-Step -Name 'Gifsicle (Giflossy)' -Script @"
if [ ! -d gifsicle ]; then
    cp -R orig gifsicle
    patch --forward -p1 -d gifsicle < gifsicle-1.89-imageoptim.patch
fi
cd gifsicle
if [ ! -f configure ]; then
    if [ -x ./bootstrap.sh ]; then ./bootstrap.sh; else autoreconf -fi; fi
fi
if [ ! -f config.status ]; then
    ./configure --disable-gifview --disable-gifdiff CFLAGS='-O2'
fi
make -j$Jobs
"@ -WorkingDirectory (Join-Path $RepoRoot 'gifsicle')
    if ($code -ne 0) { $Results['gifsicle'] = 'FAILED'; return }

    Publish-Artifact -Tool 'gifsicle' -TargetName 'gifsicle.exe' -Candidates @(
        'gifsicle/gifsicle/src/gifsicle.exe', 'gifsicle/gifsicle/src/gifsicle'
    ) | Out-Null
}

function Build-ZopfliPng {
    $code = Invoke-Step -Name 'ZopfliPNG' -Script @"
make -j$Jobs zopflipng
"@ -WorkingDirectory (Join-Path $RepoRoot 'zopfli-png\zopfli')
    if ($code -ne 0) { $Results['zopflipng'] = 'FAILED'; return }

    Publish-Artifact -Tool 'zopflipng' -TargetName 'zopflipng.exe' -Candidates @(
        'zopfli-png/zopfli/zopflipng.exe', 'zopfli-png/zopfli/zopflipng'
    ) | Out-Null
}

function Build-PngCrush {
    # The Xcode target compiles pngcrush.c and nothing else: the file pulls in
    # whatever else it needs itself, and the libpng it is built against supplies
    # the rest. Compiling the sibling .c files as well would define every zlib
    # and libpng symbol twice, and the png.h under pngcrush/tmp is from a
    # different libpng configuration, so neither shortcut works here.
    $libDir = Join-Path $RepoRoot '.build-win\libpng'
    $lib = Get-ChildItem $libDir -Filter 'libpng*.a' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $lib) {
        Write-Host ''
        Write-Host '==> pngcrush' -ForegroundColor Cyan
        Write-Host '    skipped: libpng was not built' -ForegroundColor Red
        $Results['pngcrush'] = 'FAILED'
        return
    }

    # The generated pnglibconf.h has to come before the source tree's copy, so
    # that the headers match the library actually built.
    $incBuild = ConvertTo-MsysPath $libDir
    $incSrc = ConvertTo-MsysPath (Join-Path $RepoRoot 'libpng')
    $libMsys = ConvertTo-MsysPath $lib.FullName

    $code = Invoke-Step -Name 'pngcrush' -Script @"
gcc -O3 -fomit-frame-pointer -I'$incBuild' -I'$incSrc' \
    -o pngcrush.exe pngcrush.c '$libMsys' -lz -lm
"@ -WorkingDirectory (Join-Path $RepoRoot 'pngcrush')
    if ($code -ne 0) { $Results['pngcrush'] = 'FAILED'; return }

    Publish-Artifact -Tool 'pngcrush' -TargetName 'pngcrush.exe' -Candidates @(
        'pngcrush/pngcrush.exe'
    ) | Out-Null
}

function Build-Guetzli {
    $code = Invoke-Step -Name 'Guetzli' -Script @"
make -j$Jobs
"@ -WorkingDirectory (Join-Path $RepoRoot 'guetzli\guetzli')
    if ($code -ne 0) { $Results['guetzli'] = 'FAILED'; return }

    Publish-Artifact -Tool 'guetzli' -TargetName 'guetzli.exe' -Candidates @(
        'guetzli/guetzli/bin/Release/guetzli.exe',
        'guetzli/guetzli/bin/Release/guetzli'
    ) | Out-Null
}

function Build-CargoTool {
    param(
        [Parameter(Mandatory)] [string] $Tool,
        [Parameter(Mandatory)] [string] $Directory,
        [string] $ExtraArgs = ''
    )

    $code = Invoke-Step -Name "$Tool (cargo)" -Script @"
cargo build --release --target x86_64-pc-windows-gnu $ExtraArgs
"@ -WorkingDirectory (Join-Path $RepoRoot $Directory)
    if ($code -ne 0) { $Results[$Tool] = 'FAILED'; return }

    Publish-Artifact -Tool $Tool -TargetName "$Tool.exe" -Candidates @(
        "$Directory/target/x86_64-pc-windows-gnu/release/$Tool.exe"
    ) | Out-Null
}

function Build-Svgo {
    # svgo/build/svgo.js is a committed webpack bundle; the Windows front-end runs
    # it with Electron's own Node, so there is nothing to compile. Rebuild it only
    # if it is missing and npm is available.
    Write-Host ''
    Write-Host '==> SVGO' -ForegroundColor Cyan

    $bundle = Join-Path $RepoRoot 'svgo\build\svgo.js'
    if (-not (Test-Path $bundle)) {
        if (Get-Command npm -ErrorAction SilentlyContinue) {
            Invoke-Mingw -Script 'npm ci && npx webpack' -WorkingDirectory (Join-Path $RepoRoot 'svgo') | Out-Null
        }
    }
    if (-not (Test-Path $bundle)) {
        Write-Host '    svgo/build/svgo.js missing and could not be rebuilt' -ForegroundColor Red
        $Results['svgo'] = 'FAILED'
        return
    }

    $dst = Join-Path (Split-Path $OutDir -Parent) 'svgo.js'
    Copy-Item -LiteralPath $bundle -Destination $dst -Force
    $size = [math]::Round((Get-Item $dst).Length / 1KB)
    Write-Host "    svgo.js  ($size KB)" -ForegroundColor Green
    $Results['svgo'] = 'built'
}

# ------------------------------------------------------------------------- main

Write-Host 'ImageOptim - Windows optimizer build' -ForegroundColor White
Write-Host "repo:   $RepoRoot"
Write-Host "output: $OutDir"
Write-Host "tools:  $($Targets -join ', ')"
Write-Host "jobs:   $Jobs"

Assert-Msys2

if ($Clean -and (Test-Path $BuildDir)) {
    Write-Host "Removing $BuildDir"
    Remove-Item $BuildDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not $SkipBootstrap) { Install-Dependencies }

$needsCargo = @('oxipng', 'pngquant', 'svgcleaner') | Where-Object { $Targets -contains $_ }
if ($needsCargo) { Resolve-Cargo | Out-Null }

foreach ($tool in $Targets) {
    switch ($tool) {
        'libpng'     { Build-LibPng }
        'mozjpeg'    { Build-MozJpeg }
        'jpegoptim'  { Build-Jpegoptim }
        'advpng'     { Build-AdvPng }
        'gifsicle'   { Build-Gifsicle }
        'zopflipng'  { Build-ZopfliPng }
        'pngcrush'   { Build-PngCrush }
        'guetzli'    { Build-Guetzli }
        'oxipng'     { Build-CargoTool -Tool 'oxipng'     -Directory 'oxipng/oxipng' }
        # pngquant links libpng and Little CMS statically so the bin directory
        # stays free of DLLs the installer would otherwise have to ship.
        'pngquant'   { Build-CargoTool -Tool 'pngquant'   -Directory 'pngquant/src' -ExtraArgs '--no-default-features --features=static,z-static' }
        'svgcleaner' { Build-CargoTool -Tool 'svgcleaner' -Directory 'svgcleaner/src' }
        'svgo'       { Build-Svgo }
    }
}

Write-Host ''
Write-Host 'Summary' -ForegroundColor White
$failed = 0
foreach ($key in $Results.Keys) {
    $state = $Results[$key]
    if ($state -eq 'built') {
        Write-Host ("  {0,-12} {1}" -f $key, $state) -ForegroundColor Green
    } else {
        Write-Host ("  {0,-12} {1}" -f $key, $state) -ForegroundColor Red
        $failed++
    }
}

Write-Host ''
if ($failed -gt 0) {
    Write-Host "$failed tool(s) failed. The front-end skips optimizers whose executable is absent," -ForegroundColor Yellow
    Write-Host 'so a partial build still runs - with fewer optimizers.' -ForegroundColor Yellow
    exit 1
}

Write-Host "All tools built into $OutDir" -ForegroundColor Green
Write-Host 'Next: cd win; npm install; npm run dist:win'
