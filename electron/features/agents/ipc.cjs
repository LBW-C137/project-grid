function registerAgentsIpc({ handle, agents, openExternal, getSession, findProject, getRestoreCwd, listClaudeSessions, listCodexSessions, followClaudeSession, listAgentCommands, t }) {
  handle('agents:status', () => agents.getState());
  handle('agents:install', agent => agents.install(agent));
  handle('agents:open-node', () => openExternal('https://nodejs.org/'));
  handle('terminal:actions', id => { findProject(id); return getSession(id)?.actions.list || []; });
  handle('terminal:conversation', id => { findProject(id); return getSession(id)?.conversation.snapshot() || []; });
  handle('terminal:agentSessions', id => {
    const project = findProject(id), s = getSession(id);
    if (!s) return [];
    // Over SSH the conversations are on that computer: its worker lists them (integration/remote-worker.py).
    if (project.kind === 'ssh') return s.agent === 'codex' && s.terminal?.request ? s.terminal.request('codex-sessions', { currentId: s.rootThreadId || s.reportedThreadId || null }) : [];
    const cwd = getRestoreCwd(id) || project.path;
    // Codex's own list leaves out the conversation it is in; so does this one.
    if (s.agent === 'codex') return listCodexSessions(cwd, s.rootThreadId || s.reportedThreadId, s.codexHome);
    if (s.agent !== 'claude') return [];
    return listClaudeSessions(cwd, s.codexActive ? s.claudeSessionId : s.claudeResumeId);
  });
  handle('terminal:followAgentSession', async (id, sessionId) => {
    const project = findProject(id), s = getSession(id);
    if (project.kind === 'ssh' || !s?.codexActive || s.agent !== 'claude') return false;
    return followClaudeSession(project, s, sessionId);
  });
  handle('terminal:commands', async id => {
    const project = findProject(id), s = getSession(id);
    const commands = await listAgentCommands({ agent: s?.agent || 'claude', projectPath: project.kind === 'ssh' ? undefined : project.path });
    return commands.map(command => command.source === 'builtin' ? { ...command, description: t(command.description) } : command);
  });
}

module.exports = { registerAgentsIpc };
