// A run of an agent's CLI that is not a conversation: `codex update`, `claude --version`, `codex login`, `claude mcp
// list`. The shell integrations send the first word given to the CLI (a subcommand or an option, never a prompt of
// several words); the reading view then says what the run does and shows its output, and nothing is handed over,
// read or restored for it as it is for a conversation.
const COMMANDS = {
  codex: ['update', 'upgrade', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'debug', 'apply', 'a', 'exec', 'e',
    'sandbox', 'cloud', 'features', 'doctor', 'help', '--version', '-V', '--help', '-h'],
  claude: ['update', 'upgrade', 'install', 'migrate-installer', 'doctor', 'mcp', 'config', 'plugin', 'setup-token', 'login', 'logout', 'auth',
    '--version', '-v', '-V', '--help', '-h', '-p', '--print'],
};

// The command when this run is one of these, else null (a conversation, new or resumed).
function agentCommand(agent, word) {
  if (typeof word !== 'string' || !/^-{0,2}[A-Za-z][A-Za-z-]{0,23}$/.test(word)) return null;
  return COMMANDS[agent === 'claude' ? 'claude' : 'codex'].includes(word) ? word : null;
}

module.exports = { agentCommand };
