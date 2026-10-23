---
name: code-standard
description: The owner's mandatory code standard for every change in Agentrix, by Codex, subagents and the lead alike — less redundancy, lower complexity, idiomatic code, no behaviour change. Use whenever writing, refactoring or reviewing code, and paste it into every worker brief.
---

# Code standard

Goal: less redundant code, lower cognitive complexity, better readability, maintainability and execution efficiency.

## Rules

1. **No redundant code.** Remove duplicated logic, pointless intermediate variables, needless wrapper functions and
   boilerplate.
2. **Simple control flow.** Avoid redundant if/else, deep nesting and tangled branches; use early returns and pattern
   matching where they make the code clearer.
3. **Concise code.** Shorten verbose expressions and functions, but never at the cost of readability.
4. **Clear structure.** Split functions and modules whose responsibility is unclear; extract only logic that is
   really reused; no over-abstraction.
5. **Readability.** Consistent naming and formatting; comment complex business logic (why, not what); delete
   meaningless comments. Match the surrounding code's style and comment density.
6. **No code smells.** Fix duplicated code, overlong functions, oversized modules, over-design and unnecessary
   dependencies.

## Principles

- Keep existing behaviour, external interfaces and expected results unchanged.
- Do not trade clarity for fewer lines.
- Add no unnecessary abstractions, design patterns or new dependencies.
- Prefer the language's idiomatic way of doing things.
- Change in stages and verify each stage with the existing tests.
- Finish with a summary: redundancy removed, complexity reduced, problems left.

## For the lead

Put this file's rules in every Codex or subagent brief, and review each returned diff against them before accepting
it; send a diff that breaks them back with the specific lines.
