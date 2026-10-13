---
name: cli-screen-capture
description: When a Claude Code or Codex update changes a screen the reading view parses (a picker, a dialog, the footer, a slider), capture the real screen in isolation and turn it into a parser fixture before changing the parser.
---

# Capturing a CLI screen for the reading view's parsers

The reading view understands the CLIs by reading their terminal screens (`src/features/agents/agent-screen.ts`,
`src/features/reading/cli-panel.ts`, `cli-render.ts`, `sign-in-screen.ts`). A CLI update that moves one row breaks
it quietly: a popup that never opens, a sign-in card that stays, chrome shown as command output. Fix it from the real
screen, never from a screenshot or memory.

## Steps

1. Write a probe under `.test-output/` that launches Agentrix with an isolated profile (`AGENTRIX_DATA_DIR` in a new
   folder, `terminalRenderer: 'dom'`) and reads the rows from `[data-terminal-id="<id>"] .xterm-rows > div`
   (replace ` ` with a space, trim the ends).
2. Keep the user's CLI state untouched:
   - Codex: point `CODEX_HOME` at a folder of the run with fake rollouts (`sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`,
     `session_meta` with the project `cwd`), `auth.json` holding a placeholder API key
     (`{"OPENAI_API_KEY":"sk-placeholder-not-a-key"}`), and a `config.toml` with `sandbox_mode`,
     `[windows] sandbox = "unelevated"` and `[projects.'<folder>'] trust_level = "trusted"` for the project and the
     repository root, so no sign-in, sandbox or trust prompt comes first. Nothing is sent to a model.
   - Claude Code: run it in `<repo>/.test-output/slash-live-project` (already trusted), only local commands, and leave
     dialogs with Esc so no setting changes.
   - Send only navigation keys (Tab, arrows, Esc, Ctrl+C); never Enter on a list of real sessions.
3. Save the rows as `tests/fixtures/screens/<agent>-<what>.txt` with personal paths replaced (`~\work\demo-app`), and add
   its full expectation to the `expected` table in `tests/agent-screen.test.cjs` (every fixture must have one).
4. Change the parser, run `npm test`, then confirm against the live CLI with the probe or `scripts/slash-live.mjs`.

## Lessons

- Claude Code 2.1.296 draws its effort over the input box (`◉ xhigh · /effort`) and may head the model line with `●`;
  `/effort` became a centred slider with an Ultracode switch beside it.
- Codex 0.162 prints `fast` after the effort in its footer, and its resume list's Esc means "start new" after
  `codex resume` but "back" after `/resume`.
- A dialog may draw its own search field like the input box (Claude's `/config`): never drop input-looking rows from a
  dialog, only rows known to be chrome.
