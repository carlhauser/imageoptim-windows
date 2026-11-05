# Security

Please report a vulnerability privately, through this repository's
**Security** tab → **Report a vulnerability**, rather than in a public issue.

Most useful to hear about:

- anything in the Windows app (`win/`) that lets a file, a folder name or a
  web page make it do something it should not - run a program, write outside
  the files it was given, or lose the original of a file it was given;
- the update path: releases, `latest.yml`, the installer and the portable zip;
- `build-windows.ps1` and the workflows in `.github/`.

The optimizers themselves (OxiPNG, pngquant, MozJPEG, libwebp, libavif and the
rest) are upstream projects vendored here; a flaw in one is best reported to
it as well, and this repository then takes the fixed release.

Releases carry `SHA256SUMS.txt` and a build provenance attestation. To check a
download came from this repository's workflow:

```
gh attestation verify ImageOptim-Setup-<version>.exe --repo carlhauser/imageoptim-windows
```
