# Agentrix working agreements

- Apply the user's `apply-gpt-5p6-guidance` skill silently for every request.
- Route every task by `skills/model-routing/SKILL.md` before doing any of it, without being asked: clear non-design tasks and all debugging go to Codex first, design and polish to a Sonnet subagent; the lead agent plans, briefs, decides, reviews, verifies and releases, and takes over only when a worker fails. A worker (a Codex run or a subagent) does its task itself and never delegates further.
- Do not start reviewer agents or impose a separate reviewer workflow unless the user explicitly requests it again.
- Run native GUI checks sequentially with isolated `AGENTRIX_DATA_DIR` profiles. Never close, restart or type into the user's real Agentrix sessions to run tests.
- Preserve small-card terminal interaction: typing, selecting and copying inside a terminal must not expand a project. Expansion belongs to the project header, waiting-status action and explicit expand button.
- Completion notifications must not be rearmed by idle/background callbacks. Automatic round completion and acknowledgment remain supported; do not reintroduce manual project-completion controls or VS Code launch actions.
