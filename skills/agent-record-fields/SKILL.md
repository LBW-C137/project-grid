---
name: agent-record-fields
description: Use when Agentrix should show something new that Codex or Claude Code write in their own records (model, effort, tokens, context window, plan limits, provider), or when a value shows for local projects but stays empty over SSH.
---

# Reading a new fact from the agents' records

Both CLIs already write what they use and spend. Read it from their records; never wrap their status line, call their
APIs or read their credentials.

## Where each agent writes it

- **Codex rollout** (`<CODEX_HOME>/sessions/**/rollout-*.jsonl`):
  - `session_meta.payload.model_provider`: the provider id (`openai`, or a custom id whose `base_url` is in
    `config.toml` under `[model_providers.<id>]`).
  - `turn_context.payload.model` and `effort`, plus `event_msg` `thread_settings_applied`, whose `service_tier`
    `priority` means fast mode.
  - `event_msg` `token_count`, after every model call:
    - `info.total_token_usage`: running totals; `input_tokens` includes `cached_input_tokens`.
    - `info.last_token_usage.total_tokens`: the context the last call filled.
    - `info.model_context_window`.
    - `rate_limits.primary` / `secondary`: `used_percent`, `window_minutes` (300 = 5 hours, 10080 = a week) and
      `resets_at` in Unix seconds.
    - `info` can be `null`, as in the first count of a session, which brings only the limits.
- **Claude Code transcript** (`<config>/projects/<folder>/<session>.jsonl`):
  - Each `assistant` record has `message.model` and `message.usage`: `input_tokens`, `cache_creation_input_tokens`,
    `cache_read_input_tokens` and `output_tokens`.
  - One reply is written as several records with the same `message.id`, each repeating the usage. Count a reply once,
    keeping its last usage.
  - Skip `isSidechain` records (subagents) and the model `<synthetic>`.
  - There are no plan limits and no context window. Window: 1M for models marked `native_1m` in the CLI's model table
    (Opus 4.7 and later, Sonnet 5, Haiku 5.5, Fable, Mythos) or named with `[1m]`, else 200k. Any context above 200k
    means 1M.
  - Claude Code 2.1.300 writes a new session's first prompt after the reply to it, though the prompt's `timestamp` is
    earlier. Tell rounds by timestamp, not by order in the file.
  - The conversation's first prompt has `parentUuid: null`. The reader only reads the last 8 MB of a long transcript
    (`transcript-window.cjs`), so a conversation total is known only when that prompt was read.
  - `cost-state` records (cumulative `modelUsage` and cost) belong to the Claude **process**, not the conversation:
    they restart with a new `startTime`. They are written only now and then, such as on exit, so they can't be a live
    figure.

## The three places to change

1. **The local reader.** `electron/features/agents/agent-settings.cjs` covers model, effort and fast mode.
   `agent-usage.cjs` covers provider, context, tokens and limits. Both are fed from `noteSettings` in `main.cjs`.
   Reset per conversation in the `onHistory(false)` callbacks.
2. **SSH compaction.** `integration/remote-worker.py`: `compact_record` for Codex and `compact_claude_record` for
   Claude drop every field they don't list. A new field must be kept there, or SSH projects show nothing.
   Add a test to `tests/remote_worker_test.py`.
3. **The memory history.** `history_records` (also `remote-worker.py`) reuses the compaction. Filter out records
   that carry no conversation (such as `token_count`), so they don't eat its byte budget.

## Checking it

Replay a real record file through the reader in a scratch script, read-only, and compare with what the CLI itself shows.
The desktop smoke `scripts/completion-smoke.mjs` appends `turn_context` and `token_count` records to a fake rollout and
checks the activity pane.
