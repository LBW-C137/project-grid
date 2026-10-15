---
name: release-flow
description: Publish a new Agentrix version — bump, update notes, the full local test pass, commit, tag, push and watch CI. Use when asked to 发布新版本 / release.
---

# Releasing Agentrix

1. **Version.** `npm version X.Y.Z --no-git-tag-version` (updates package.json and package-lock.json).
2. **Docs.** `docs/usage.md` names the version four times (the `AGENTRIX_VERSION=` lines and the macOS zip name);
   replace them all.
3. **Update notes.** Replace `WHATS_NEW` in `src/features/guide/guide.ts` with this release's changes: one plain
   Chinese sentence each, what the user sees, no internals. Add each sentence's English to the end of
   `electron/locales/en.json` (keep the older entries). The guide opens on this page after an update.
4. **Local checks, in order.** `npm run build`, `npm test`, `python -m unittest discover -s tests -p '*_test.py'`,
   then the sixteen desktop suites one at a time (each starts Electron with its own isolated profile; never run
   them in parallel or against the real app): `test:desktop`, `test:path-refresh`, `test:sessions`,
   `test:restore-slow`, `test:completion`, `test:gpu-terminal`, `test:workspace`, `test:editor-terminals`,
   `test:themes-markdown`, `test:visual`, `test:navigation`, `test:git`, `test:cmd`, `test:material`,
   `test:composer`, `test:reading`.
5. **Look at the pictures.** `test:workspace` saves `guide-whats-new.png` and `guide-shortcuts.png` in its
   `.test-output/workspace-*` folder: check the notes fit and read well before committing.
6. **Commit.** Stage everything except local-only files (`.claude/`, personal product drafts under `docs/`), scan
   the staged diff for personal data (user names, home paths, host addresses, emails, secrets) and commit as
   `Release X.Y.Z: <the user-visible changes>` with a bulleted body.
7. **Tag and push.** `git tag vX.Y.Z`, push `main`, then push the tag. Both pushes run the build workflow; only the
   tag's run adds the "Publish GitHub Release" job, which waits for every build and uploads the installers.
8. **CI.** Query the runs for the full commit SHA (`/actions/runs?head_sha=<full sha>`; a short SHA returns
   nothing). Read the token from `git credential fill` inside the script and never print it. The jobs: Windows x64,
   Linux x64, Linux arm64, macOS Apple silicon, and Linux SSH integration (the real-ssh check of the remote worker).
   Wait for both runs, then confirm the release lists its assets.
9. **A failed job.** The tag's release is published only if every build passes. Read the failed step from the job
   log (`/actions/jobs/<id>/logs`; search for `Error:` and `Timed out`, since passing test names also contain
   "failed"), and download the run's `desktop-test-screenshots` artifact: each smoke saves `failure.png` when it fails.
   If the same commit passed in the branch run, the failure is a race, not this release: re-running the failed jobs
   finishes the release. Re-running is a write action, so ask before using the token for it.
10. **Short temp paths on Windows CI.** The runner's temp folder is an 8.3 name (`C:\Users\RUNNER~1\…`). A test
   comparing a path the app resolved with `fs.promises.realpath` (native: it spells the long name out) must expect
   `fs.realpathSync.native`, not `fs.realpathSync` (which keeps `RUNNER~1`). To reproduce locally, set `TEMP` and
   `TMP` to the `ShortPath` of a long-named folder (`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(<dir>).ShortPath`).
11. **A race only CI hits.** CI runs a 1024×768 window on two slow cores. To reproduce locally, run a temporary copy
   of the smoke that, right after `firstWindow()`, sets `setContentSize(1024, 768)` and slows the renderer through
   CDP: `(await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 6 })`. The window
   size alone did not reproduce it; rate 4 trips earlier, unrelated timing checks. Log `terminal:resize` from
   `ipcMain` with timestamps to see whether a refit lands mid-output. A step that resizes terminals and then types
   must `await terminalsSettled(page)` first. Delete the temporary copy afterwards.
