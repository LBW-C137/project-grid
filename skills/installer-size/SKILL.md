---
name: installer-size
description: What keeps the Agentrix installers small and what must be updated with it — the on-demand speech engine pins, the resources.pak trim manifest, differential updates, the Linux tar.xz. Use when upgrading Electron or sherpa-onnx, when an afterPack/pak error stops a build, or when asked to shrink the installers further.
---

# Installer size

## What is left out, and how

- **Speech engine** (`sherpa-onnx-<platform>-<arch>`): not packaged (`build.files` excludes it); `electron/voice.cjs`
  downloads it with the voice model from the npm registry, npmmirror as fallback, pinned by `RUNTIME_VERSION` and the
  `RUNTIMES` sha512 integrities. Development checkouts use the copy in `node_modules`.
- **Chromium resources** (first-run intro sounds, DevTools frontend, chrome://tracing): `scripts/after-pack.cjs` trims
  `resources.pak` with `scripts/trim-electron-pak.cjs`, pinned per platform in `scripts/electron-pak-trim.json`. It fails
  closed: an unknown input hash stops the build.
- Already removed earlier: `default_app.asar`, `dxcompiler.dll`/`dxil.dll`, all locales but zh-CN/en-US.
- Linux ships AppImage plus `tar.xz`.

## When upgrading

- **sherpa-onnx**: copy the new version and the four platform `integrity` values from `package-lock.json` into
  `RUNTIMES` in `electron/voice.cjs`, with each `.tgz`'s byte size as `size` (its Content-Length). Run `node --test tests/voice-runtime.test.cjs`.
- **Electron**: the pak manifest no longer matches and the build stops. Download the official zips for darwin-arm64,
  linux-x64, linux-arm64 (verify against the release's `SHASUMS256.txt`), take Windows from `node_modules/electron/dist`,
  run `node scripts/trim-electron-pak.cjs --regenerate <version> <platform-arch> <resources.pak>` for each and merge the
  entries. Regeneration identifies the groups by content and refuses when it cannot.

## Measuring

- Build two unpacked apps (`npm run pack -- --config.directories.output=<dir>`), then real installers from them with
  `npx electron-builder --win nsis --x64 --prepackaged <dir>/win-unpacked --publish never`; per-component estimates with
  `7za a -mx=9 -md=1m -ms=off` (the differential-update settings).
- Keep differential updates: electron-builder then forces 7z normal, 1 MB dictionary, non-solid (about 10 MB larger),
  but an update downloads only 2–5 MB instead of the full installer.

## Tried and rejected

- AVIF wallpapers: at SSIM ≥ 0.985 against the WebP, only 0.14 MB saved.
- Removing `chrome_200_percent.pak` (blurry media controls on HiDPI), `d3dcompiler_47.dll`, SwiftShader, node-pty's
  bundled ConPTY, alternate FFmpeg (loses H.264/AAC), fuses, minifying the main process: risk out of proportion or
  under 0.5 MB each.
