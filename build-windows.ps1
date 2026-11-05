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
      libwebp     libwebp         libwebp            (CMake: cwebp, webpmux)
      aom         AOM AV1 codec   aom                (CMake, static, linked by libavif)
      libavif     libavif         libavif            (CMake: avifenc, avifdec; links aom,
                                                      libpng and MozJPEG)

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
    Delete the intermediate build directory before starting. That includes the
    AOM library, which is otherwise reused for as long as aom/ and its build
    flags stay the same.

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
    'pngcrush', 'guetzli', 'oxipng', 'pngquant', 'svgcleaner', 'svgo',
    'libwebp', 'aom', 'libavif'
)

# jpegoptim links against the MozJPEG static library, so asking for jpegoptim
# alone has to pull MozJPEG in with it.
$Targets = if ($Only.Count) { $Only } else { $AllTools }
# jpegoptim links MozJPEG's static library and pngcrush links libpng's, so those
# have to be built first. Moving the dependency to the front rather than only
# adding it when absent: -Only jpegoptim,mozjpeg used to keep the given order and
# fail. libavif links all three of aom, libpng and MozJPEG; each pair moves its
# dependency in front of everything, so all three end up before it.
$Dependencies = @(
    @('jpegoptim', 'mozjpeg'), @('pngcrush', 'libpng'),
    @('libavif', 'aom'), @('libavif', 'libpng'), @('libavif', 'mozjpeg')
)
foreach ($pair in $Dependencies) {
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

# The C tools take their arguments and open their files through the ANSI API:
# a MinGW main() gets argv in the system code page, and fopen calls
# CreateFileA. Any character that page cannot hold - Chinese or Japanese on a
# Western PC, any emoji anywhere - arrives as '?', and so does nothing past 260
# characters. The tool then fails to open the file, which the app cannot tell
# from "already optimal". This manifest makes the process's code page UTF-8
# (Windows 10 1903 and later) and lets it use long paths, so the same ANSI calls
# take any path. It replaces MinGW's default manifest, whose asInvoker and
# supported-OS entries it keeps. libavif links one like it for its own apps;
# every executable gets this one, so they all behave alike.
$Utf8Manifest = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>
'@

function Set-Utf8Manifest {
    param([Parameter(Mandatory)] [string] $Path)

    if (-not ('ImageOptimBuild.Resources' -as [type])) {
        Add-Type -Namespace ImageOptimBuild -Name Resources -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cb);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
'@
    }

    $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($Utf8Manifest)
    $handle = [ImageOptimBuild.Resources]::BeginUpdateResource($Path, $false)
    if ($handle -eq [IntPtr]::Zero) { return $false }
    # RT_MANIFEST (24), resource 1, language-neutral: the same type, name and
    # language as MinGW's default manifest, so it is replaced, not duplicated.
    if (-not [ImageOptimBuild.Resources]::UpdateResource($handle, [IntPtr]24, [IntPtr]1, 0, $bytes, [uint32]$bytes.Length)) {
        [ImageOptimBuild.Resources]::EndUpdateResource($handle, $true) | Out-Null
        return $false
    }
    return [ImageOptimBuild.Resources]::EndUpdateResource($handle, $false)
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
            # Symbols are no use in a release - Guetzli's alone were 7 MB - and
            # they have to go before the manifest does: UpdateResource drops
            # the COFF symbol table but leaves the header pointing at it, and
            # objdump then calls the file "format not recognized".
            if ((Invoke-Mingw -Script "strip --strip-all '$(ConvertTo-MsysPath $dst)'") -ne 0) {
                Write-Host "    could not strip $TargetName" -ForegroundColor Red
                Remove-Item -LiteralPath $dst -Force
                $Results[$Tool] = 'FAILED'
                return $false
            }
            if (-not (Set-Utf8Manifest -Path $dst)) {
                # Kept, since it still works on every path its code page can
                # spell, but reported: test\binaries.test.js fails on it too
                Write-Host "    could not set the UTF-8 manifest on $TargetName" -ForegroundColor Red
                $Results[$Tool] = 'FAILED'
                return $false
            }
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
        'mingw-w64-x86_64-gflags',
        # AOM generates its CPU dispatch tables with a Perl script
        'perl'
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

function Build-LibWebp {
    # Only cwebp and webpmux. The app hands cwebp nothing but WebP, so the PNG,
    # JPEG, TIFF and GIF readers are left out (TIFF is already skipped by
    # WEBP_LINK_STATIC; it is listed in case that changes), and with them any
    # chance of a MinGW DLL creeping in.
    #
    # WIC is off as well. With it, cwebp decodes every input - WebP included -
    # through the Windows Imaging Component first, so the result depends on
    # which WebP codec the PC has installed (most Windows 11 machines have the
    # Store's WebP Image Extensions), and WIC hands back the ICC profile and
    # nothing else: -metadata all silently lost EXIF and XMP. Without WIC cwebp
    # uses libwebp's own reader, which carries ICC, EXIF and XMP over byte for
    # byte. HAVE_WINCODEC_H is the result of the header check, so presetting it
    # skips the check.
    $code = Invoke-Step -Name 'libwebp (cwebp, webpmux)' -Script @"
cmake -G Ninja -S libwebp -B .build-win/libwebp \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_EXE_LINKER_FLAGS=-static \
    -DWEBP_LINK_STATIC=ON \
    -DWEBP_BUILD_CWEBP=ON \
    -DWEBP_BUILD_WEBPMUX=ON \
    -DWEBP_BUILD_LIBWEBPMUX=ON \
    -DWEBP_BUILD_DWEBP=OFF \
    -DWEBP_BUILD_ANIM_UTILS=OFF \
    -DWEBP_BUILD_GIF2WEBP=OFF \
    -DWEBP_BUILD_IMG2WEBP=OFF \
    -DWEBP_BUILD_VWEBP=OFF \
    -DWEBP_BUILD_WEBPINFO=OFF \
    -DWEBP_BUILD_EXTRAS=OFF \
    -DCMAKE_DISABLE_FIND_PACKAGE_PNG=ON \
    -DCMAKE_DISABLE_FIND_PACKAGE_JPEG=ON \
    -DCMAKE_DISABLE_FIND_PACKAGE_TIFF=ON \
    -DCMAKE_DISABLE_FIND_PACKAGE_GIF=ON \
    -DCMAKE_DISABLE_FIND_PACKAGE_OpenGL=ON \
    -DHAVE_WINCODEC_H=OFF
cmake --build .build-win/libwebp --parallel $Jobs --target cwebp webpmux
"@
    if ($code -ne 0) {
        $Results['cwebp'] = 'FAILED'
        $Results['webpmux'] = 'FAILED'
        return
    }

    Publish-Artifact -Tool 'cwebp' -TargetName 'cwebp.exe' -Candidates @(
        '.build-win/libwebp/cwebp.exe'
    ) | Out-Null
    Publish-Artifact -Tool 'webpmux' -TargetName 'webpmux.exe' -Candidates @(
        '.build-win/libwebp/webpmux.exe'
    ) | Out-Null
}

# Configure flags for AOM, kept in one place because they are part of the stamp
# that decides whether an existing build can be reused.
#
# AOM_TARGET_CPU is named rather than detected: AOM reads it from
# CMAKE_SYSTEM_PROCESSOR, which CMake takes from PROCESSOR_ARCHITECTURE, and a
# MinGW shell started from Git Bash rather than PowerShell does not have that
# variable. AOM then quietly falls back to its generic C target, with no SIMD
# at all, and encodes several times slower.
#
# Only the library: the apps, examples, tests and tools are off, and so are
# libyuv and WebM, which only the apps use. Their sources are not vendored.
#
# Changing these? Bump the r<N> in the AOM cache key in
# .github/workflows/windows.yml as well. The stamp already stops CI linking a
# library built with the old flags, but only a new key lets it save the new one.
$AomFlags = @(
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DAOM_TARGET_CPU=x86_64',
    '-DENABLE_NASM=ON',
    '-DENABLE_APPS=OFF',
    '-DENABLE_DOCS=OFF',
    '-DENABLE_EXAMPLES=OFF',
    '-DENABLE_TESTDATA=OFF',
    '-DENABLE_TESTS=OFF',
    '-DENABLE_TOOLS=OFF',
    '-DCONFIG_LIBYUV=0',
    '-DCONFIG_WEBM_IO=0'
)

# Identifies an AOM build: the configure flags and the content of every file in
# aom/. CI restores .build-win/aom-prefix from a cache keyed on aom/** alone, so
# after a change to the flags above it would otherwise link a library built
# with the old ones.
function Get-AomStamp {
    $root = (Join-Path $RepoRoot 'aom').TrimEnd('\') + '\'
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add("flags: $($AomFlags -join ' ')")
    Get-ChildItem -LiteralPath $root -Recurse -File | Sort-Object FullName | ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
        $lines.Add("$($_.FullName.Substring($root.Length)) $hash")
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
        return ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '')
    } finally {
        $sha.Dispose()
    }
}

function Build-Aom {
    # A static libaom.a, installed into .build-win/aom-prefix for libavif to
    # link. It is the largest thing compiled here and changes rarely, so an
    # existing build is reused for as long as its stamp matches; CI caches the
    # prefix between runs. -Clean removes it.
    $prefix = Join-Path $BuildDir 'aom-prefix'
    $lib = Join-Path $prefix 'lib\libaom.a'
    $stampFile = Join-Path $prefix 'imageoptim-build-stamp.txt'
    $stamp = Get-AomStamp

    if ((Test-Path $lib) -and (Test-Path $stampFile) -and
        ((Get-Content -LiteralPath $stampFile -Raw).Trim() -eq $stamp)) {
        Write-Host ''
        Write-Host '==> AOM (static library)' -ForegroundColor Cyan
        Write-Host '    reusing .build-win/aom-prefix: same sources, same flags' -ForegroundColor Green
        $Results['aom'] = 'cached'
        return
    }

    $prefixMsys = ConvertTo-MsysPath $prefix
    $flags = $AomFlags -join ' '
    # The old prefix goes first, so that a failed build leaves nothing behind
    # for libavif to link rather than the library the stamp just rejected.
    $code = Invoke-Step -Name 'AOM (static library)' -Script @"
rm -rf '$prefixMsys'
cmake -G Ninja -S aom -B .build-win/aom $flags -DCMAKE_INSTALL_PREFIX='$prefixMsys'
cmake --build .build-win/aom --parallel $Jobs
cmake --install .build-win/aom
"@
    if ($code -ne 0 -or -not (Test-Path $lib)) {
        if ($code -eq 0) { Write-Host '    AOM built but libaom.a was not installed' -ForegroundColor Red }
        $Results['aom'] = 'FAILED'
        return
    }

    [System.IO.File]::WriteAllText($stampFile, $stamp + "`n")
    $size = [math]::Round((Get-Item $lib).Length / 1KB)
    Write-Host "    libaom.a  ($size KB)" -ForegroundColor Green
    $Results['aom'] = 'built'
}

function Build-LibAvif {
    # avifenc and avifdec, with AOM for both encoding and decoding, and libpng,
    # MozJPEG and zlib for the PNG and JPEG they read and write. libpng and
    # MozJPEG are the static builds above; zlib is MSYS2's libz.a, the one
    # libpng and pngcrush already link.
    $aomPrefix = Join-Path $BuildDir 'aom-prefix'
    $aomLib = Join-Path $aomPrefix 'lib\libaom.a'
    $pngBuild = Join-Path $BuildDir 'libpng'
    $jpegBuild = Join-Path $BuildDir 'mozjpeg'
    $missing = @()
    if (-not (Test-Path $aomLib)) { $missing += 'AOM' }
    if (-not (Get-ChildItem $pngBuild -Filter 'libpng*.a' -ErrorAction SilentlyContinue)) { $missing += 'libpng' }
    if (-not (Get-ChildItem $jpegBuild -Filter 'libjpeg*.a' -ErrorAction SilentlyContinue)) { $missing += 'MozJPEG' }
    if ($missing.Count) {
        Write-Host ''
        Write-Host '==> libavif' -ForegroundColor Cyan
        Write-Host "    skipped: $($missing -join ', ') not built" -ForegroundColor Red
        $Results['avifenc'] = 'FAILED'
        $Results['avifdec'] = 'FAILED'
        return
    }

    # libavif's CMake configures avifgainmaputil along with the apps, and that
    # links libargparse, which it fetches from GitHub with FetchContent at
    # configure time. avifgainmaputil is never built here (only the avifenc and
    # avifdec targets are), so an empty stand-in satisfies the configure step
    # and keeps the build offline. FETCHCONTENT_FULLY_DISCONNECTED makes any
    # other download attempt fail rather than happen.
    $stub = Join-Path $BuildDir 'libavif-no-argparse'
    New-Item -ItemType Directory -Force -Path $stub | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $stub 'CMakeLists.txt'), @"
cmake_minimum_required(VERSION 3.10)
project(libargparse_stand_in NONE)
add_library(libargparse INTERFACE)
"@)

    # libpng and MozJPEG are installed into one prefix, so that each has its
    # generated header (pnglibconf.h, jconfig.h) beside the others: FindPNG and
    # FindJPEG take a single include directory. Every library is named by path,
    # because MSYS2's own libpng16.dll.a and libz.dll.a sit on the default search
    # path and would link the DLLs. PKG_CONFIG_LIBDIR keeps pkg-config to the AOM
    # just built.
    $deps = ConvertTo-MsysPath (Join-Path $BuildDir 'libavif-deps')
    $aom = ConvertTo-MsysPath $aomPrefix
    $stubMsys = ConvertTo-MsysPath $stub
    $code = Invoke-Step -Name 'libavif (avifenc, avifdec)' -Script @"
rm -rf '$deps'
cmake --install .build-win/libpng --prefix '$deps'
cmake --install .build-win/mozjpeg --prefix '$deps'
PKG_CONFIG_LIBDIR='$aom/lib/pkgconfig' cmake -G Ninja -S libavif -B .build-win/libavif \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_EXE_LINKER_FLAGS=-static \
    -DAVIF_BUILD_APPS=ON \
    -DAVIF_BUILD_TESTS=OFF \
    -DAVIF_BUILD_EXAMPLES=OFF \
    -DAVIF_CODEC_AOM=SYSTEM \
    -DAVIF_CODEC_DAV1D=OFF \
    -DAVIF_CODEC_LIBGAV1=OFF \
    -DAVIF_CODEC_RAV1E=OFF \
    -DAVIF_CODEC_SVT=OFF \
    -DAVIF_LIBYUV=OFF \
    -DAVIF_LIBSHARPYUV=OFF \
    -DAVIF_LIBXML2=OFF \
    -DAVIF_JPEG=SYSTEM \
    -DAVIF_ZLIBPNG=SYSTEM \
    -DAOM_INCLUDE_DIR='$aom/include' \
    -DAOM_LIBRARY='$aom/lib/libaom.a' \
    -DPNG_PNG_INCLUDE_DIR='$deps/include' \
    -DPNG_LIBRARY='$deps/lib/libpng16.a' \
    -DJPEG_INCLUDE_DIR='$deps/include' \
    -DJPEG_LIBRARY='$deps/lib/libjpeg.a' \
    -DZLIB_INCLUDE_DIR=/mingw64/include \
    -DZLIB_LIBRARY=/mingw64/lib/libz.a \
    -DFETCHCONTENT_FULLY_DISCONNECTED=ON \
    -DFETCHCONTENT_SOURCE_DIR_LIBARGPARSE='$stubMsys'
cmake --build .build-win/libavif --parallel $Jobs --target avifenc avifdec
"@
    if ($code -ne 0) {
        $Results['avifenc'] = 'FAILED'
        $Results['avifdec'] = 'FAILED'
        return
    }

    Publish-Artifact -Tool 'avifenc' -TargetName 'avifenc.exe' -Candidates @(
        '.build-win/libavif/avifenc.exe'
    ) | Out-Null
    Publish-Artifact -Tool 'avifdec' -TargetName 'avifdec.exe' -Candidates @(
        '.build-win/libavif/avifdec.exe'
    ) | Out-Null
}

# --locked: exactly the crates each Cargo.lock names. Without it every build took
# whatever was newest, and ran those crates' build scripts in the build job.
function Build-CargoTool {
    param(
        [Parameter(Mandatory)] [string] $Tool,
        [Parameter(Mandatory)] [string] $Directory,
        [string] $ExtraArgs = ''
    )

    $code = Invoke-Step -Name "$Tool (cargo)" -Script @"
cargo build --locked --release --target x86_64-pc-windows-gnu $ExtraArgs
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
        'libwebp'    { Build-LibWebp }
        'aom'        { Build-Aom }
        'libavif'    { Build-LibAvif }
    }
}

Write-Host ''
Write-Host 'Summary' -ForegroundColor White
$failed = 0
foreach ($key in $Results.Keys) {
    $state = $Results[$key]
    if ($state -eq 'built' -or $state -eq 'cached') {
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
