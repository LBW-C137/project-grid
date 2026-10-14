---
name: ssh-remote-worker
description: Use when changing how an SSH project's terminals talk to the server (electron/remote-connection.cjs, integration/remote-worker.py, the bootstrap in electron/ssh-config.cjs), adding a request the worker answers, or when SSH terminals open slowly, ask for the password again, or one terminal's trouble reaches another.
---

# SSH terminals and the remote worker

## How it fits together

- One SSH process per host (`RemoteLink`, keyed by ssh path, config file, host and askpass) carries every terminal
  opened there. Its first stdin line is `remote-worker.py`, zlib-compressed and base64 (the bootstrap in
  `sshArguments` decompresses it). A terminal after the first opens without another handshake, login or password.
- Each terminal is a channel (`RemoteConnection`): every message both ways carries `channel`. Agentrix sends
  `{op: "open", channel, path, codingPath, projectId, token, cols, rows, readingNote}` and the worker answers with its
  terminal output, then `ready`; `{op: "shutdown", channel}` closes only that terminal. The SSH process ends when the
  last channel leaves (stdin closes, the worker exits on EOF).
- A message without `channel` from the worker is about the whole connection: an `error` there fails every terminal.
  So does SSH exiting (its stderr is shown in each terminal).
- In the worker, `serve()` reads the messages; each `Channel` has its own `Worker`, request pool and input pool, and
  opens in a thread of its own so a slow folder or Git read never holds the other terminals' keys.
  `Worker.lock` makes a shutdown that arrives while the shell starts wait for it.

## When changing it

- Change both ends together: the worker is sent fresh on every connection, so there is no old worker to stay
  compatible with. Keep the fake worker in `tests/helpers/ssh-fixture.cjs` speaking the same protocol: the Windows
  tests and five desktop smokes (sessions, editor-terminals, git, navigation, themes-markdown) run through it.
- Requests a terminal makes (files, Git, Codex/Claude status) go through its own channel; nothing is shared between
  workers but the process, `os.environ` and stdout (written under one lock).

## Testing

- `node --test tests/ssh-connection.test.cjs`: real OpenSSH against a local ssh2 server. On Windows it uses the fake
  worker; on Linux (the CI job "Linux SSH integration") it runs the real Python worker and PTY.
- `python -m unittest discover -s tests -p "*_test.py"`: `serve()` with channels runs on Windows too (the PTY is
  stubbed); PTY tests are skipped off Linux.
- A local `python -u -c '<bootstrap>'` fed the compressed worker checks the bootstrap; it stops at `SIGHUP` on Windows,
  which is expected (the server is always Linux).
- For a real server, use a scratch SSH config and known_hosts in the test output folder and a temporary askpass file
  that is deleted right after; never put the password on a command line or in the repository.
