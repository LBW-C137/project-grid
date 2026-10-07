// Codex notify and Claude Code hooks for macOS terminals (zsh-integration.zsh), run by Project Grid's own
// executable as Node (ELECTRON_RUN_AS_NODE=1). It sends the same events as notify.ps1 and claude-hook.ps1.
// Usage: agent-event.cjs codex-notify <socket> <projectId> <sessionKey> <payload>
//        agent-event.cjs claude-hook <socket> <projectId> <sessionKey> start|stop   (the hook's JSON on stdin)
// Claude adds anything a hook prints to the conversation, so this writes nothing, and a closed Project Grid
// never delays or fails a turn.
const net = require('node:net');
const { createHash } = require('node:crypto');

function send(socket, event) {
  return new Promise(resolve => {
    const connection = net.connect(socket);
    const done = () => { connection.destroy(); resolve(); };
    connection.setTimeout(750, done);
    connection.on('error', done);
    connection.on('close', done);
    connection.on('connect', () => connection.end(JSON.stringify(event) + '\n'));
  });
}

function readInput(limit = 4 * 1024 * 1024) {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; if (data.length > limit) { data = ''; process.stdin.destroy(); resolve(''); } });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

// Codex supplies one JSON argument per completed turn. Never infer completion from process exit, terminal
// silence, or words in model output.
function codexEvent(payload, projectId, sessionKey) {
  const notification = JSON.parse(payload);
  if (notification?.type !== 'agent-turn-complete') return null;
  const threadId = String(notification['thread-id'] ?? ''), turnId = String(notification['turn-id'] ?? '');
  const eventId = threadId && turnId ? `${threadId}:${turnId}` : createHash('sha256').update(payload, 'utf8').digest('hex').toUpperCase();
  return { projectId, sessionKey, type: 'turn-complete', eventId, threadId, turnId };
}

// Claude Code hook: UserPromptSubmit reports a working turn, Stop reports a finished one.
function claudeEvent(input, projectId, sessionKey, kind) {
  if (!['start', 'stop'].includes(kind)) return null;
  const hook = JSON.parse(input);
  const sessionId = String(hook?.session_id ?? '');
  if (!sessionId) return null;
  const prompt = kind === 'start' && hook.prompt ? String(hook.prompt).slice(0, 2000) : null;
  return {
    projectId, sessionKey, type: 'agent-activity', agent: 'claude', state: kind === 'stop' ? 'complete' : 'working', sessionId,
    // Where Claude writes this conversation; Project Grid reads the steps of the round from it.
    transcriptPath: String(hook.transcript_path ?? ''),
    eventId: `${sessionId}:${Date.now()}${String(process.hrtime.bigint() % 10000n).padStart(4, '0')}`,
    // The submitted prompt names the work; the spoken completion notice says what finished.
    prompt,
  };
}

async function main([action, socket, projectId, sessionKey, argument]) {
  if (!socket || !projectId || !sessionKey) return;
  const event = action === 'codex-notify' ? codexEvent(argument, projectId, sessionKey)
    : action === 'claude-hook' ? claudeEvent(await readInput(), projectId, sessionKey, argument) : null;
  if (event) await send(socket, event);
}

if (require.main === module) {
  // Whatever happens, the agent continues: no output, exit code 0, and never longer than a few seconds.
  setTimeout(() => process.exit(0), 5000).unref();
  main(process.argv.slice(2)).catch(() => {}).finally(() => process.exit(0));
}

module.exports = { codexEvent, claudeEvent };
