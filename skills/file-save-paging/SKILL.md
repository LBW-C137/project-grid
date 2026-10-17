---
name: file-save-paging
description: Use when changing Agentrix autosave, editor save races, paged text editing, or text and Markdown pagination in file popups.
---

# Preserve drafts and page boundaries

- `FilePreview.tsx`: a save belongs to one file/page session. Serialize writes, use each returned revision for the
  next write, and drain newer drafts typed during quiet autosave. Keep quiet editing enabled, stop after a failure,
  and ignore stale results after switching or unmounting. Explicit saves and navigation guards must flush the latest
  draft. Release preview resources owned by the old session without touching a new session's state.
- `electron/project-files.cjs` and `integration/remote-worker.py` implement the same byte paging. Adjacent pages must
  choose the same boundary, preserving multibyte characters, UTF-16 surrogate pairs, BOMs and CRLF pairs. Compare
  complete saved bytes after editing either side of a boundary; checking rendered text alone misses extra CR bytes.
- `FilePopup.tsx` must pass the requested page to the reader and provide navigation for paged text and Markdown.
  Keep reads bounded and release resources from superseded loads. HTML, image, video and external-document previews
  keep their separate behavior.

Run `node --test tests/files-preview.test.cjs tests/file-edit.test.cjs`, Python worker tests, a build, and
`node scripts/reading-hierarchy-smoke.mjs` in sequence with other GUI checks. Its isolated profile exercises a slow
save with a newer edit and a popup's second page; inspect `autosave-latest.png` and `popup-second-page.png`.
