---
name: agent-readable-files
description: Use when Agentrix writes a file that Codex or Claude Code will read for themselves (handoff notes, the project memory book, notes in a project folder), or when an agent reports that such a file looks garbled on Windows.
---

# Files written for agents to read

Codex on Windows reads files with Windows PowerShell 5.1 (`Get-Content`), which decodes UTF-8 **without** a byte order
mark as the system code page (GBK on a Chinese system). Chinese text then arrives as mojibake and the agent silently
ignores what it says: the handoff "works" but the agent knows nothing.

## Rule

- Write such files through `forAgents(text)` from `electron/features/agents/project-memory.cjs`: on Windows it puts a
  UTF-8 byte order mark (`﻿`) in front, elsewhere it leaves the text alone. `handoff.cjs` and the memory book
  already do.
- Agentrix's own records (the JSONL memory archive it parses) stay without the mark; only text meant for an agent gets
  it. Write the mark as the escape `'﻿'`, never as the invisible character itself.
- Files sent to an SSH server (Linux) get no mark.

## Check it

In a real Windows PowerShell 5.1 (not pwsh 7, which defaults to UTF-8):

```powershell
Get-Content -Raw '<file>'        # Chinese reads correctly only when the file starts with the mark
```

`tests/handoff.test.cjs` asserts the mark on win32 and its absence elsewhere.
