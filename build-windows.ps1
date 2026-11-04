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
# jpegoptim links MozJPEG's static library and pngcrush links libpng's, so those
# have to be built first. Moving the dependency to the front rather than only
# adding it when absent: -Only jpegoptim,mozjpeg used to keep the given order and
# fail.
foreach ($pair in @(@('jpegoptim', 'mozjpeg'), @('pngcrush', 'libpng'))) {
    $dependent, $dependency = $pair
    if ($Targets -contains $dependent) {
        $Targets = @($dependency) + ($Targets | Where-Object { $_ -ne $dependency })
    }
}
foreach ($t in $Targets) {
    if ($AllTools -notcontains $t) {
        throw "Unknown tool '$t'. Known tools: $($AllTools -join ', ')"
    }
}

$Results = [ordered]@{}

# Windows directories to prepend inside the MinGW shell: just the toolchains that
# live outside MSYS2, such as rustup's cargo and Node.
$ExtraPathDirs = New-Object System.Collections.Generic.List[string]

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

    # Only the directories we actually need are added, rather than the whole
    # Windows PATH. Inheriting it is the classic way to break a MinGW build:
    # Strawberry Perl's gcc, Windows cmake.exe, sh.exe and link.exe all shadow
    # the MSYS2 tools.
    $prefix = ''
    if ($script:ExtraPathDirs.Count) {
        $converted = $script:ExtraPathDirs | ForEach-Object { ConvertTo-MsysPath $_ }
        $prefix = "export PATH='$($converted -join ':')':`$PATH; "
    }
    # stderr is folded into stdout inside bash. Windows PowerShell 5.1 - the shell
    # Windows ships - turns each stderr line of a native command into an error
    # record whenever the caller redirects output (`*> build.log`, Tee-Object),
    # and with $ErrorActionPreference = 'Stop' the first one is terminating. A
    # pacman "is up to date -- skipping" warning was enough to abort the whole
    # build. PowerShell 7, which CI uses, does not do this, so CI never saw it.
    $full = "exec 2>&1; ${prefix}set -euo pipefail; cd '$msysCwd'; $Script"

    $env:MSYSTEM         = 'MINGW64'
    $env:CHERE_INVOKING  = '1'
    $env:MSYS2_PATH_TYPE = 'minimal'

    # Failure is reported through the exit code, never by throwing; this is local
    # to the function.
    $ErrorActionPreference = 'Continue'

    # The script goes to bash as a file, not as `bash -lc <script>`. Windows
    # PowerShell 5.1 does not escape double quotes inside an argument it hands a
    # native program, so any `"` in a script split it into several arguments and
    # bash ran a truncated fragment. PowerShell 7 escapes them, which is why it
    # only ever broke outside CI. Line endings are normalised in case this file
    # is checked out with CRLF.
    $scriptFile = [System.IO.Path]::GetTempFileName()
    try {
        $body = ($full -replace "`r`n", "`n") + "`n"
        [System.IO.File]::WriteAllText($scriptFile, $body, (New-Object System.Text.UTF8Encoding $false))

        # Send the build log straight to the console; otherwise it joins this
        # function's output stream and the caller gets an array instead of a code.
        & $Bash -l (ConvertTo-MsysPath $scriptFile) | Out-Host
        return $LASTEXITCODE
    } finally {
        Remove-Item -LiteralPath $scriptFile -Force -ErrorAction SilentlyContinue
    }
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

# Nothing is shipped beside the executables, so each must load with only Windows'
# own DLLs. One that imports a MinGW runtime - libstdc++, libgcc_s, winpthread,
# zlib1, libpng16 - starts on the build machine and on any PC that happens to
# have Git for Windows' mingw64\bin on PATH, and fails with 0xC0000135 (DLL not
# found) everywhere else, which the app cannot tell from "already optimal".
# An early build shipped five optimizers like that. Anything the executable
# imports that exists in MinGW's own bin directory is not a system DLL.
function Test-SelfContained {
    param([Parameter(Mandatory)] [string] $Path)

    $exe = ConvertTo-MsysPath $Path
    $code = Invoke-Mingw -Script @"
bad=`$(objdump -p '$exe' | awk '/DLL Name:/ {print `$3}' | while read -r dll; do
    if [ -f "/mingw64/bin/`$dll" ]; then printf '%s ' "`$dll"; fi
done)
if [ -n "`$bad" ]; then
    echo "    not self-contained; needs MinGW DLLs that are not shipped: `$bad"
    exit 1
fi
"@
    return ($code -eq 0)
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
            if (-not (Test-SelfContained -Path $dst)) {
                # Deleted rather than left in place: the app lists a missing
                # optimizer as missing, but runs a present one, and a run that
                # cannot load its DLLs reads as "no improvement".
                Remove-Item -LiteralPath $dst -Force
                $Results[$Tool] = 'FAILED'
                return $false
            }
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

    # pacman -Sy on its own is a partial upgrade, which MSYS2 documents as a way to
    # corrupt an installation, so the database and the packages move together with
    # -Syu. The catch is that when the first pass updates msys2-runtime, pacman
    # terminates every MSYS2 process - including the shell running it - by design.
    # A `||` fallback inside that same shell therefore never executes: the process
    # is already gone. Each pass needs its own invocation.
    Write-Host ''
    Write-Host '==> Updating MSYS2 (first pass; may close its own shell)' -ForegroundColor Cyan
    Invoke-Mingw -Script 'pacman -Syu --noconfirm' | Out-Null

    $code = Invoke-Step -Name 'Updating MSYS2 (second pass)' -Script 'pacman -Syu --noconfirm'
    if ($code -ne 0) { throw 'MSYS2 could not be brought up to date; re-run the script.' }

    $code = Invoke-Step -Name 'Installing MSYS2 build dependencies' -Script @"
pacman -S --noconfirm --needed $packages
"@
    if ($code -ne 0) { throw 'pacman failed; fix the package installation and re-run.' }
}

# Rust: prefer the user's rustup (newer compiler), fall back to MSYS2's package.
# Everything else here is MinGW, so Rust must target x86_64-pc-windows-gnu to
# keep one ABI across the whole bin directory.
function Resolve-Cargo {
    # Whichever toolchain wins has to be the one actually on PATH inside the
    # MinGW shell, so the chosen cargo's directory is registered rather than
    # merely reported.
    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    $rustup = Get-Command rustup -ErrorAction SilentlyContinue

    if ($cargo -and $rustup) {
        $dir = Split-Path $cargo.Source -Parent
        Write-Host "    using rustup's cargo at $dir" -ForegroundColor DarkGray
        # rustup reports progress on stderr, and under Windows PowerShell 5.1 a
        # `2>&1` with $ErrorActionPreference = 'Stop' throws on the first line.
        & {
            $ErrorActionPreference = 'Continue'
            & rustup target add x86_64-pc-windows-gnu 2>&1 | ForEach-Object { "$_" } | Out-Host
        }
        $script:ExtraPathDirs.Insert(0, $dir)
        return
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
}

# Node is only needed if svgo's bundle has to be rebuilt, but the MinGW shell has
# no Node of its own, so make it reachable when it exists.
function Register-NodePath {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) { $script:ExtraPathDirs.Add((Split-Path $node.Source -Parent)) }
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
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DPNG_SHARED=OFF \
    -DPNG_STATIC=ON \
    -DPNG_TOOLS=OFF \
    -DPNG_TESTS=OFF
cmake --build .build-win/libpng --parallel $Jobs
"@
    if ($code -ne 0) { $Results['libpng'] = 'FAILED'; return }

    $lib = Get-ChildItem (Join-Path $RepoRoot '.build-win\libpng') -Filter 'libpng*.a' -Recurse -ErrorAction SilentlyContinue |
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
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
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
    # Built directly rather than through the bundled CMakeLists, which globs
    # every *.c and so compiles the vendored GNU getopt. That copy only builds
    # under the autotools feature macros and fails on MinGW with "too many
    # arguments to function getenv". MinGW supplies getopt_long itself, so
    # HAVE_GETOPT_H and HAVE_GETOPT_LONG select the system one and getopt.c and
    # getopt1.c are left out of the source list.
    $libDir = Join-Path $RepoRoot '.build-win\mozjpeg'
    $lib = Get-ChildItem $libDir -Filter 'libjpeg*.a' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $lib) {
        Write-Host ''
        Write-Host '==> jpegoptim' -ForegroundColor Cyan
        Write-Host '    skipped: MozJPEG static library not built' -ForegroundColor Red
        $Results['jpegoptim'] = 'FAILED'
        return
    }

    $incSrc = ConvertTo-MsysPath (Join-Path $RepoRoot 'libjpeg\src')
    $incBuild = ConvertTo-MsysPath $libDir
    $libMsys = ConvertTo-MsysPath $lib.FullName

    $code = Invoke-Step -Name 'jpegoptim' -Script @"
gcc -O3 -DHAVE_UNISTD_H=1 -DHAVE_GETOPT_H=1 -DHAVE_GETOPT_LONG=1 \
    -I. -I'$incBuild' -I'$incSrc' \
    -o jpegoptim.exe jpegoptim.c jpegdest.c misc.c '$libMsys' -lm
"@ -WorkingDirectory (Join-Path $RepoRoot 'jpegoptim\src')
    if ($code -ne 0) { $Results['jpegoptim'] = 'FAILED'; return }

    Publish-Artifact -Tool 'jpegoptim' -TargetName 'jpegoptim.exe' -Candidates @(
        'jpegoptim/src/jpegoptim.exe'
    ) | Out-Null
}

function Build-AdvPng {
    # Built in a copy under .build-win, not in advpng/ itself. configure writes
    # its Makefile over advpng/Makefile, which is ImageOptim's own (it unpacks
    # the source tarball for the macOS build), and make's regeneration rules
    # rewrote the tracked configure and config.h, leaving the checkout dirty
    # with this machine's paths in it.
    $code = Invoke-Step -Name 'AdvPNG' -Script @"
if [ ! -f .build-win/advpng/config.status ]; then
    rm -rf .build-win/advpng
    mkdir -p .build-win/advpng
    # -p keeps the timestamps, which decide whether make regenerates anything
    cp -Rp advpng/. .build-win/advpng/
    cd .build-win/advpng
    rm -rf Makefile config.status config.log stamp-h1 autom4te.cache *.o advpng.exe
    if [ ! -f configure ]; then ./autogen.sh; fi
    # aclocal.m4 and the Makefile.in files look older than their sources, so
    # make tries to regenerate them and the `missing` wrapper asks for automake
    # 1.9, which no current MSYS2 has. noautomake.sh ships with the tree to
    # touch those files and stop the regeneration.
    if [ -f noautomake.sh ]; then sh noautomake.sh; fi
    # AdvanceCOMP 1.15 is from 2012 and declares dynamic exception
    # specifications - throw() on a function - which C++17 removed and modern
    # GCC defaults to rejecting.
    ./configure --disable-dependency-tracking CFLAGS='-O2' CXXFLAGS='-O2 -std=gnu++98'
else
    cd .build-win/advpng
fi
# automake names the target with the executable suffix, so on Windows the rule
# is advpng.exe and plain `advpng` has no rule at all.
# -static: otherwise it needs libstdc++-6, libgcc_s_seh-1 and zlib1 at run time
# (see Test-SelfContained). The old binary goes first so make relinks it.
rm -f advpng.exe
make -j$Jobs advpng.exe LDFLAGS=-static
"@ -WorkingDirectory $RepoRoot
    if ($code -ne 0) { $Results['advpng'] = 'FAILED'; return }

    Publish-Artifact -Tool 'advpng' -TargetName 'advpng.exe' -Candidates @(
        '.build-win/advpng/advpng.exe'
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
# -static: otherwise it needs libwinpthread-1 at run time.
rm -f src/gifsicle.exe
make -j$Jobs LDFLAGS=-static
"@ -WorkingDirectory (Join-Path $RepoRoot 'gifsicle')
    if ($code -ne 0) { $Results['gifsicle'] = 'FAILED'; return }

    Publish-Artifact -Tool 'gifsicle' -TargetName 'gifsicle.exe' -Candidates @(
        'gifsicle/gifsicle/src/gifsicle.exe', 'gifsicle/gifsicle/src/gifsicle'
    ) | Out-Null
}

function Build-ZopfliPng {
    $code = Invoke-Step -Name 'ZopfliPNG' -Script @"
# -static: otherwise it needs libstdc++-6 and libgcc_s_seh-1 at run time.
rm -f zopflipng zopflipng.exe
make -j$Jobs zopflipng LDFLAGS=-static
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
    $lib = Get-ChildItem $libDir -Filter 'libpng*.a' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
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
gcc -O3 -fomit-frame-pointer -static -I'$incBuild' -I'$incSrc' \
    -o pngcrush.exe pngcrush.c '$libMsys' -lz -lm
"@ -WorkingDirectory (Join-Path $RepoRoot 'pngcrush')
    if ($code -ne 0) { $Results['pngcrush'] = 'FAILED'; return }

    Publish-Artifact -Tool 'pngcrush' -TargetName 'pngcrush.exe' -Candidates @(
        'pngcrush/pngcrush.exe'
    ) | Out-Null
}

function Build-Guetzli {
    # Guetzli's generated makefile links libpng through `pkg-config --libs`,
    # which is dynamic. The resulting exe runs on the build machine, where
    # MSYS2's mingw64\bin is on PATH, and dies with 0xC0000135
    # (STATUS_DLL_NOT_FOUND) anywhere else - including inside the package.
    # -static pulls libpng, libstdc++, libgcc and winpthread in. AdvPNG,
    # Gifsicle, Pngcrush and ZopfliPNG had the same fault and are linked the
    # same way; Test-SelfContained now refuses any exe that still has it.
    #
    # zlib has to be named separately. The makefile asks pkg-config for libpng
    # without --static, so it gets -lpng16 alone, and a statically linked
    # libpng16.a then has nothing to resolve its own deflate and inflate calls
    # against. It goes in LIBS rather than LDFLAGS because the generated link
    # line puts LDFLAGS before -lpng16, and ld resolves left to right.
    #
    # The old binary goes first: changing only link flags leaves make thinking
    # the target is up to date, and it would publish the dynamic one again.
    $code = Invoke-Step -Name 'Guetzli' -Script @"
rm -f bin/Release/guetzli bin/Release/guetzli.exe
make -j$Jobs LDFLAGS=-static LIBS=-lz
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

    # A crate inside a workspace puts its binary under the workspace root's
    # target/, not its own, so look in the parents too before giving up.
    $candidates = @("$Directory/target/x86_64-pc-windows-gnu/release/$Tool.exe")
    $probe = $Directory
    while ($probe -and $probe -ne '.') {
        $probe = Split-Path $probe -Parent
        if ($probe) { $candidates += "$probe/target/x86_64-pc-windows-gnu/release/$Tool.exe" }
    }
    $candidates += "target/x86_64-pc-windows-gnu/release/$Tool.exe"

    Publish-Artifact -Tool $Tool -TargetName "$Tool.exe" -Candidates $candidates | Out-Null
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

Register-NodePath
$needsCargo = @('oxipng', 'pngquant', 'svgcleaner') | Where-Object { $Targets -contains $_ }
if ($needsCargo) { Resolve-Cargo }

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
