---
name: native-approvals
description: Maintain native CLI request identity, owned transports, and approval cards without reopening screen-derived PTY approvals.
---

# Native approvals

Read `electron/features/terminal/native-{approvals,protocol,session,ipc}.cjs`, `NativeApprovalCard.tsx`, and `ManagedSession.tsx` before changing approval behavior. `agent:launch` with mode `native` binds a fresh terminal generation directly to its owned provider transport. Codex uses its real remote TUI; Claude is explicitly SDK-managed. Legacy/SSH permissions stay terminal-only.

Keep CLI-issued IDs typed and unchanged; tokens are renderer capabilities only. Never correlate hooks, screen text, events or epochs with a native request. Never add approval PTY writes or automatic response retries. Preserve tool input, provider/project/terminal/generation bindings, cancellation, tombstones, bounds and TUI/host arbitration. Never inject blanket PreToolUse allow hooks.

Run `node --test tests/native-approvals.test.cjs tests/native-approval-ui.test.cjs tests/approval-aba.test.cjs tests/agent-permissions.test.cjs tests/agent-launch.test.cjs tests/reading-ui.test.cjs` and `npx tsc --noEmit`. Use harmless Node subprocess fixtures; describe them as synthetic.

The lead can run `node scripts/native-approval-probe.cjs codex --run-installed` and the equivalent `claude` command to test installed CLIs against `scripts/native-approval-model.cjs`, a local stand-in. Without `--run-installed` the probe does not execute any CLI. It resolves executables through `resolveCli`, creates fresh homes and an empty probe cwd, inherits only an environment allowlist, uses dummy local credentials, bounds timeouts and cleans up owned processes. It records installed versions and CLI-issued native IDs in `.test-output/native-approval-probe/<provider>-*/report.json`. Codex cancellation must be selected from the actual supported decisions (prefer `cancel`, then `decline`); Claude requests harmless creation of `native-proof.txt` inside probe cwd to trigger permission review, then denies it. Never replace that write with an automatically permitted echo. Inspect successful reports before claiming installed-CLI proof; unit/Node/VM fixtures are synthetic evidence only. Desktop checks remain the lead's responsibility, sequentially with isolated `AGENTRIX_DATA_DIR`; never use real account directories or sessions. Do not copy private prompts/auth into fixtures or documentation.
