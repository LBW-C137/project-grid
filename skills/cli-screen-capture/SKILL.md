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
   (turn non-breaking spaces into plain ones, trim the ends).
2. Keep the user's CLI state untouched:
   - Codex: point `CODEX_HOME` at a folder of the run with fake rollouts (`sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`,
     `session_meta` with the project `cwd`), `auth.json` holding a placeholder API key
     (`{"OPENAI_API_KEY":"<secret>"}`), and a `config.toml` with `sandbox_mode`,
     `[windows] sandbox = "unelevated"` and `[projects.'<folder>'] trust_level = "trusted"` for the project and the
     repository root, so no sign-in, sandbox or trust prompt comes first. Nothing is sent to a model.
   - Claude Code: run it in `<repo>/.test-output/slash-live-project` (already trusted), only local commands, and leave
     dialogs with Esc so no setting changes.
   - Send only navigation keys (Tab, arrows, Esc, Ctrl+C); never Enter on a list of real sessions.
3. Save the rows as `tests/fixtures/screens/<agent>-<what>.txt` with personal paths replaced (`~\work\demo-app`), and add
   its full expectation to the `expected` table in `tests/agent-screen.test.cjs` (every fixture must have one).
4. Change the parser, run `npm test`, then confirm against the live CLI with the probe or `scripts/slash-live.mjs`.

## Prompts that need a model turn (Codex approvals)

An approval only shows after the model asks for a tool. Never use the real sign-in: point Codex at a stand-in on
`127.0.0.1` instead (`scripts/codex-approval-probe.mjs` does it and checks the reading view).

- `config.toml`: `model = "gpt-6-sol"` (an older model name first shows a "Meet GPT-6 Sol" choice),
  `model_provider = "standin"` with `[model_providers.standin]` `base_url = "http://127.0.0.1:<port>/v1"`,
  `wire_api = "responses"`, `env_key` naming a variable set in the app's environment; `approval_policy = "on-request"`
  (`untrusted` is refused since 0.162) and `sandbox_mode = "read-only"`.
- Answer `POST /v1/responses` with Server-Sent Events: `response.created`, one `response.output_item.done`, then
  `response.completed` with zero usage. Codex 0.162 gives GPT-6 its tools in code mode, so ask for one with a
  `custom_tool_call` named `exec` whose `input` is JavaScript: `await tools.exec_command({cmd: "…", sandbox_permissions:
  "require_escalated", justification: "…"})` for a command, `await tools.apply_patch("*** Begin Patch\n…")` for an edit.
- Codex also asks the same server for a title; reply to anything else with a plain assistant message, and to the output
  of your own call (its `call_id`) with one too.
- Leave each prompt with Esc ("No, and tell Codex what to do differently"): nothing runs, nothing is remembered.

## Lessons

- Claude Code 2.1.296 draws its effort over the input box (`◉ xhigh · /effort`) and may head the model line with `●`;
  `/effort` became a centred slider with an Ultracode switch beside it.
- Codex 0.162 prints `fast` after the effort in its footer, and its resume list's Esc means "start new" after
  `codex resume` but "back" after `/resume`.
- Codex 0.162.1's footer has no context part before the first message (`GPT-6-Sol default · <folder>`); a parser that
  needs `· 90% left` never sees Codex idle, and every slash command's popup then waits forever. Capture a fresh
  conversation as well as one in progress. `/fast` there prints `• Service tier set to priority`.
- Codex 0.162.1 may put a tip under its last answer (`  └ Tip: Moving from Claude Code? Use /import …`) and removes it
  when the next command starts. Never anchor on it: rows taken as "the history when the command was sent" must skip
  it, or the anchor vanishes and the whole conversation looks like the command's output. Capture after several
  rounds (a stand-in model with long answers), not only on a fresh screen.
- Codex 0.162 draws its whole conversation in the terminal's alternate screen: no xterm scrollback and no line markers
  tell how far it scrolled, only the rows on screen. It pins the current turn's prompt (`› …`) to the top row once the
  turn scrolled past it. Run the same command several times in a row (`/status` 4×): a repeat prints the same rows
  again, the history's last rows recur in the new output, and once the screen holds nothing but copies, before and
  after read the same. Find where the history ends by the whole run of history rows above a place, never by the last
  one or two rows alone.
- Codex asks "Would you like to run the following command?", "…make the following edits?" (hotkey `(a)` for "don't ask
  again for these files"), "…grant these permissions?" and "<server> needs your approval."; match the family, not one
  title.
- GPT-6's code-mode calls pass their arguments as JavaScript string literals (`tools.apply_patch("…\n…")`): decode the
  literal before reading file names out of a patch.
- A dialog may draw its own search field like the input box (Claude's `/config`): never drop input-looking rows from a
  dialog, only rows known to be chrome.
