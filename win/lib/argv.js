'use strict';

// Paths passed on the command line, which is how Windows hands over files when
// you open an image with the app or drop one on its icon.

const fs = require('fs');
const path = require('path');

// NTFS paths are case-insensitive.
function samePath(a, b) {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// argv: as the process, or a second instance, received it. cwd: the folder
// it was started in. A relative path means relative to the folder it was
// typed in. For a second launch that is not this process's working directory,
// and resolving against ours could match a different file of the same name -
// which would then be optimized and overwritten. 'second-instance' passes the
// caller's directory.
//
// appDir: the app's own folder when it runs from a checkout, as
// `electron <app>` - `npm start`, or electron.exe pointed at a checkout. That
// folder is then one of the arguments. Skipping only the literal "." let
// `electron C:\...\win` treat the checkout as a dropped folder and rewrite
// every image inside it. It is matched by value: it is argv[1] at startup,
// but in the argv a second instance forwards, Chromium has moved its switches
// in front of it.
function filePathsFromArgv(argv, cwd = process.cwd(), { appDir = null } = {}) {
    const own = appDir ? path.resolve(appDir) : null;
    return argv
        .slice(1)
        .filter((arg) => typeof arg === 'string' && !arg.startsWith('-') && arg !== '.')
        .map((arg) => path.resolve(cwd, arg))
        .filter((file) => !(own && samePath(file, own)))
        .filter((file) => {
            try {
                const stat = fs.statSync(file);
                return stat.isFile() || stat.isDirectory();
            } catch (err) {
                return false;
            }
        });
}

module.exports = { filePathsFromArgv, samePath };
