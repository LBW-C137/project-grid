const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification, clipboard, shell, protocol, net: electronNet } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const { WorkspaceStore } = require('./state.cjs');
const { createEventServer } = require('./events.cjs');
const { listDirectory, readProjectFile, saveProjectFile, resolveProjectPath, VIDEO_TYPES } = require('./project-files.cjs');
const { projectPaths } = require('./project-paths.cjs');
const { ProjectGit } = require('./project-git.cjs');
const { isTerminalResponse, acceptShellEvent, SubmissionTracker, PromptMarkers } = require('./terminal-input.cjs');
const { createTerminalEnvironment } = require('./terminal-env.cjs');
const { PreviewResources, resourceResponse } = require('./preview-resources.cjs');
const { resolveTerminalLink } = require('./terminal-links.cjs');
const { UpdateManager, isInstalledBuild } = require('./updates.cjs');
const { getSSHInfo } = require('./ssh-config.cjs');
const { SSHAuthServer } = require('./ssh-auth.cjs');
const { RemoteConnection } = require('./remote-connection.cjs');
const { recentSession, resumeCommand, claudeResumeCommand } = require('./session-restore.cjs');
const { CodexActivityReader, monitorActivity } = require('./codex-activity.cjs');
const { TerminalTitleTracker } = require('./terminal-title.cjs');
const { FileOperations } = require('./file-operations.cjs');
const { ClipboardWrites } = require('./clipboard-writes.cjs');
const { VoiceManager } = require('./voice.cjs');
const { SpeechManager } = require('./speech.cjs');
const { summarizeTask } = require('./task-summary.cjs');
const { ActionLog, TranscriptTail, claudeRecord, codexRecord, skillDescription } = require('./agent-actions.cjs');
const { AgentsManager, onPath } = require('./agents.cjs');
const DEFAULT_SHORTCUTS = require('./shortcuts.json');
const { windowsAppId, materializeIcon, repairShortcuts, refreshSearchIcons } = require('./windows-integration.cjs');

const root = path.join(__dirname, '..');
const integrationDir = app.isPackaged ? path.join(process.resourcesPath, 'integration') : path.join(root, 'integration');
const devUrl = !app.isPackaged ? process.env.PROJECT_GRID_DEV_URL : null;
if (process.env.PROJECT_GRID_DATA_DIR) app.setPath('userData', path.resolve(process.env.PROJECT_GRID_DATA_DIR));
app.setName('Project Grid');
const installed = isInstalledBuild(app.isPackaged, process.execPath);
const appUserModelId = windowsAppId({ packaged: app.isPackaged, installed, profile: process.env.PROJECT_GRID_DATA_DIR });
app.setAppUserModelId(appUserModelId);
protocol.registerSchemesAsPrivileged([
  { scheme: 'project-grid', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'project-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const { translate } = require('./i18n.cjs');
// Text shown by the main process follows the language chosen in settings (Chinese source -> locales/en.json).
const t = (text, values) => translate(store?.settings.language, text, values);
let window, tray, store, eventServer, sshAuth, updateManager, quitting = false, installingUpdate = false;
let userFullScreen = false;
const sessions = new Map();
const branches = new Map();
const projectGit = new ProjectGit(id => remoteFor(id));
const startupErrors = new Map();
const restorePlans = new Map();
const previewResources = new PreviewResources({ remote: project => remoteFor(project.id) });
let stateTimer;
let runtimeDir;
let sshAskpassPath;
let sshAskpassDir;
let activeTerminal = null;
let activeFileTree = null;
let fileOperations, fileProgress = null;
let voiceManager, speechManager;
let attentionTimer;
let editorDirty = false, editorCloseRequest = null, editorFile = null;
const fileSaves = new Set();
const clipboardWrites = new ClipboardWrites();
const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmdPath = process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
function send(channel, data) { if (window && !window.isDestroyed()) window.webContents.send(channel, data); }
const agents = new AgentsManager({ onChange: state => send('agents:changed', state), translate: t });
function findProject(id) {
  if (typeof id !== 'string') throw new Error('无效的项目。');
  const project = store.findTerminal(id)?.project;
  if (!project) throw new Error('项目不存在。');
  return project;
}
function publicState() {
  return {
    projects: store.projects.map(p => {
      const terminals = terminalIds(p).map((id, index) => {
        const s = sessions.get(id);
        return { id, title: t('终端 {n}', { n: index + 1 }), shell: s?.shellKind || (p.kind === 'ssh' ? 'bash' : store.settings.shell), sessionId: s?.sessionId || null, status: s?.status || 'stopped', codexActive: s?.codexActive || false, agent: s?.codexActive ? s.agent || 'codex' : null,
          codexActivity: s?.codexActivity || 'unknown', shellReady: !!s?.ready && !s?.inputDirty, codexAvailable: s?.codexAvailable ?? null,
          lastActivityAt: s?.lastActivityAt || null, lastCompletedAt: s?.lastCompletedAt || null, error: s?.error || startupErrors.get(id) || null,
          // The step a working agent is on, for the card's one-line status; the full list is sent separately.
          action: s?.codexActive && s.codexActivity === 'working' ? briefAction(s.actions.current()) : null };
      });
      const first = terminals[0];
      const activeCodex = terminals.filter(item => item.codexActive);
      const activity = activeCodex.some(item => item.codexActivity === 'working') ? 'working' : activeCodex.some(item => item.codexActivity === 'interrupted') ? 'interrupted' : activeCodex.length && activeCodex.every(item => item.codexActivity === 'complete') ? 'complete' : 'unknown';
      const status = activeCodex.length ? 'codex' : terminals.some(item => item.status === 'shell') ? 'shell' : terminals.some(item => item.status === 'starting') ? 'starting' : first.status;
      return {
        id: p.id, name: p.name, path: p.path, unread: p.unread, lastCompletedAt: p.lastCompletedAt, awaitingCompletion: p.completionArmed,
        kind: p.kind || 'local', ssh: p.ssh || null,
        branch: branches.get(p.id) || '',
        terminals, sessionId: first.sessionId, status,
        codexActive: activeCodex.length > 0, codexActivity: activity, agent: activeCodex[0]?.agent || null,
        shellReady: first.shellReady, codexAvailable: first.codexAvailable,
        lastActivityAt: first.lastActivityAt, error: terminals.find(item => item.error)?.error || null,
        action: terminals.find(item => item.action)?.action || null,
      };
    }),
    settings: store.settings,
    warning: store.warning,
    platform: process.platform,
    version: app.getVersion(),
    // The usage guide opens on first use and after each update. Isolated test profiles skip it unless asked.
    guide: store.settings.guideVersion !== app.getVersion() && (!process.env.PROJECT_GRID_DATA_DIR || process.env.PROJECT_GRID_TEST_GUIDE === '1'),
  };
}

function terminalIds(project) {
  const extra = (project.terminals || []).map(item => item.id);
  return !sessions.has(project.id) && project.primaryTerminalClosed === true && extra.length ? extra : [project.id, ...extra];
}

function disposeProjectTerminals(project) {
  for (const id of [project.id, ...(project.terminals || []).map(item => item.id)]) { restorePlans.delete(id); disposeTerminal(id); startupErrors.delete(id); }
}
function updateIndicators() {
  const unread = store.projects.filter(p => p.unread > 0).length;
  if (window && !window.isDestroyed()) {
    window.setTitle(`${unread ? `(${unread}) ` : ''}${t('Project Grid · 项目矩阵')}`);
    if (!unread) window.flashFrame(false);
  }
  if (tray && !tray.isDestroyed()) {
    tray.setImage(nativeImage.createFromPath(path.join(root, 'assets', unread ? 'icon-alert.png' : 'icon.png')));
    tray.setToolTip(unread ? t('Project Grid · {count} 个项目待查看', { count: unread }) : t('Project Grid · 项目矩阵'));
  }
}
// The same "Ctrl+Shift+F" form the window records (src/shortcuts.ts), from an Electron input event.
const SHORTCUT_KEYS = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter' };
function isAppShortcut(input) {
  const code = String(input.code || '');
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F([1-9]|1[0-2])$/.test(code) ? code : SHORTCUT_KEYS[code];
  if (!key) return false;
  const pressed = [input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', key].filter(Boolean).join('+');
  return Object.values({ ...DEFAULT_SHORTCUTS, ...store.settings.shortcuts }).includes(pressed);
}

// Rebuilt when the language changes; Electron menus keep the labels they were built with.
function trayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('打开项目矩阵'), click: () => showWindow() },
    { type: 'separator' },
    { label: t('退出应用'), click: () => { showWindow(); requestQuit().catch(report); } },
  ]));
}

function broadcast() {
  clearTimeout(stateTimer);
  stateTimer = null;
  updateIndicators();
  send('workspace:changed', publicState());
}
function scheduleState() { if (!stateTimer) stateTimer = setTimeout(() => { stateTimer = null; broadcast(); }, 700); }
function report(error) { send('app:error', String(error?.message || error)); }

function showWindow(id) {
  if (!window || window.isDestroyed()) return;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
  if (id) send('project:focus', id);
}

// task: a short name for what the round worked on, from its prompt (empty when unknown).
function notifyCompletion(project, task = '') {
  if (!window.isFocused()) {
    window.flashFrame(true); clearTimeout(attentionTimer);
    attentionTimer = setTimeout(() => { if (window && !window.isDestroyed()) window.flashFrame(false); }, 9000);
    attentionTimer.unref?.();
  }
  if (store.settings.notifications && Notification.isSupported()) {
    const note = new Notification({
      title: t('{name} · 本轮已完成', { name: project.name }),
      body: t('这一轮任务已结束，点击查看终端。'),
      icon: path.join(root, 'assets/icon-alert.png'),
      silent: !store.settings.sound,
    });
    note.on('click', () => showWindow(project.id));
    note.on('failed', () => {});
    note.show();
  }
  // Spoken with the system voice in the window, which knows the chosen language and phrase.
  if (store.settings.announce) send('completion:announce', { projectId: project.id, name: project.name, task });
}

function briefAction(action) { return action ? { kind: action.kind, tool: action.tool, target: action.target, detail: action.detail, done: action.done } : null; }
// The agent's steps reach the window in small batches; after a long history is read at once (a resumed
// conversation) the whole list replaces what the window has.
function publishAction(s, change) {
  if (sessions.get(s.terminalId) !== s) return;
  (s.actionChanges ||= []).push(change);
  s.actionTimer ||= setTimeout(() => {
    const changes = s.actionChanges; s.actionChanges = []; s.actionTimer = null;
    if (sessions.get(s.terminalId) !== s) return;
    send('terminal:action', changes.length > 40 || changes.some(item => item.reset) ? { id: s.terminalId, list: s.actions.list } : { id: s.terminalId, changes: changes.map(item => item.action) });
    scheduleState();
  }, 120);
}
// A skill step names the skill; what the skill is for comes from its SKILL.md, a moment later.
function describeActions(s, cwd, actions) {
  for (const action of actions || []) {
    if (action.kind !== 'skill') continue;
    skillDescription(action.target, cwd, action.skillFile).then(description => { if (description) { action.description = description; s.actions.update(action); } }).catch(() => {});
  }
}
// Claude Code writes each tool call to its transcript; follow it while the session lasts.
function followClaude(project, s, event) {
  const file = typeof event.transcriptPath === 'string' ? path.resolve(event.transcriptPath) : '';
  const home = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  if (!file || path.basename(file) !== `${event.sessionId}.jsonl` || !file.toLowerCase().startsWith(home.toLowerCase() + path.sep)) return;
  if (s.claudeTranscript?.filename !== file) {
    s.claudeTranscript = new TranscriptTail(file); s.actions.reset();
    s.activityMonitor?.stop();
    const tail = s.claudeTranscript;
    s.activityMonitor = monitorActivity(async () => { await tail.read(record => describeActions(s, project.path, claudeRecord(s.actions, record, project.path))); return null; }, () => {});
  } else void s.activityMonitor?.poll();
}

// A round being worked on ends with a spoken notice: load the voice now, so it is ready by then.
const roundsWorking = () => [...sessions.values()].some(s => s.codexActive && s.codexActivity === 'working');
function warmSpeech() { if (store.settings.announce) speechManager?.warm().catch(() => {}); }

// One place turns an agent's turn state into lights and completion alerts, for Codex and Claude alike.
function applyActivity(project, s, snapshot) {
  if (sessions.get(s.terminalId) !== s || !s.codexActive) return;
  // Resumed history and a slow response from before a new submission
  // must not make newly running work look complete.
  if (snapshot.updatedAt < Math.max(s.activitySince, s.activityInputAt)) return;
  s.rootThreadId = snapshot.threadId; s.activeTurnId = snapshot.turnId;
  // Keep the last prompt that named some work; a bare "继续" or "continue" keeps the one before it.
  if (summarizeTask(snapshot.prompt)) s.lastTask = summarizeTask(snapshot.prompt);
  if (s.agent === 'codex') store.setRestore(s.terminalId, { threadId: snapshot.threadId });
  s.codexActivity = snapshot.state;
  if (snapshot.state === 'working') { store.expectCompletion(project.id); warmSpeech(); }
  else if (snapshot.state === 'complete' && snapshot.turnId) {
    s.lastCompletedAt = snapshot.updatedAt;
    if (!project.seenEvents.includes(`${snapshot.threadId}:${snapshot.turnId}`)) store.expectCompletion(project.id);
    if (store.complete(project.id, `${snapshot.threadId}:${snapshot.turnId}`, snapshot.updatedAt)) notifyCompletion(project, s.lastTask || '');
  } else if (snapshot.state === 'interrupted') store.expectCompletion(project.id, false);
  broadcast();
}

// Claude Code hooks: UserPromptSubmit -> working, Stop -> complete (integration/claude-hook.ps1).
function claudeActivity(project, s, event) {
  if (!s.codexActive || s.agent !== 'claude' || !['working', 'complete'].includes(event.state)) return;
  if (typeof event.sessionId !== 'string' || !/^[\w-]{1,100}$/.test(event.sessionId) || typeof event.eventId !== 'string' || event.eventId.length > 200) return;
  const turnId = event.eventId.slice(event.sessionId.length + 1);
  // Remember the conversation and whether its turn is still open, so a restart can resume it and continue.
  store.setRestore(s.terminalId, { threadId: event.sessionId, interrupted: event.state === 'working' });
  followClaude(project, s, event);
  if (event.state === 'complete') void s.activityMonitor?.poll().then(() => { if (sessions.get(s.terminalId) === s && s.codexActivity !== 'working') s.actions.settle(); });
  applyActivity(project, s, { threadId: event.sessionId, turnId: event.state === 'complete' ? turnId : null, state: event.state, updatedAt: Date.now(), prompt: typeof event.prompt === 'string' ? event.prompt.slice(0, 2000) : undefined });
}

function onEvent(event) {
  const s = sessions.get(event.projectId);
  if (!s || event.sessionKey !== s.sessionKey) return;
  const project = store.projects.find(p => p.id === s.projectId);
  if (!project) return;
  if (event.type === 'agent-activity') { claudeActivity(project, s, event); return; }
  if (event.type !== 'turn-complete' && !acceptShellEvent(s, event)) return;
  if (event.type === 'shell-ready' || event.type === 'shell-prompt') {
    s.activityMonitor?.stop(); s.activityMonitor = null;
    s.codexActive = false; s.codexActivity = 'unknown'; s.reportedThreadId = null;
    s.ready = event.type === 'shell-prompt';
    s.inputDirty = false;
    s.status = 'shell';
    s.codexAvailable = event.codexAvailable === true;
    s.claudeAvailable = event.claudeAvailable === true;
    if (typeof event.codexHome === 'string') s.codexHome = event.codexHome;
    if (!quitting && typeof event.cwd === 'string') store.setRestore(s.terminalId, { cwd: event.cwd });
  } else if (event.type === 'codex-started') {
    s.ready = false;
    s.codexActive = true;
    s.status = 'codex';
    s.error = null;
    s.submissions.reset();
    s.codexActivity = 'unknown'; s.activitySince = Date.now(); s.activityInputAt = 0;
    s.actions.reset(); s.claudeTranscript = null;
    s.agent = event.agent === 'claude' ? 'claude' : 'codex';
    s.activityMonitor?.stop(); s.activityMonitor = null;
    // A terminal restores the agent it last ran. Switching agents drops the other one's conversation id.
    const previousAgent = store.findTerminal(s.terminalId)?.record.restore?.agent || 'codex';
    const agentRestore = { agent: s.agent, ...(previousAgent !== s.agent ? { threadId: null, interrupted: false } : {}) };
    if (s.agent === 'claude') {
      // Claude reports turns and its session id through hooks (claudeActivity).
      store.setRestore(s.terminalId, { terminal: true, codex: true, cwd: event.cwd, ...agentRestore });
      broadcast(); return;
    }
    store.setRestore(s.terminalId, agentRestore);
    const remoteSince = Number.isFinite(event.sentAt) ? event.sentAt : s.activitySince;
    s.activityMonitor?.stop();
    const reader = project.kind === 'ssh' ? null : new CodexActivityReader(event.cwd || project.path, event.codexHome || s.codexHome, s.activitySince, { threadId: () => s.reportedThreadId, requireBinding: () => (project.terminals?.length || 0) > 0,
      onRecord: record => describeActions(s, event.cwd || project.path, codexRecord(s.actions, record, event.cwd || project.path)) });
    s.activityMonitor = monitorActivity(
      () => reader ? reader.read() : project.terminals?.length && !s.reportedThreadId ? Promise.resolve(null) : s.terminal.request('codex-status', { since: remoteSince, threadId: s.reportedThreadId }),
      snapshot => {
        if (!reader) snapshot = { ...snapshot, updatedAt: snapshot.updatedAt + s.activitySince - remoteSince };
        applyActivity(project, s, snapshot);
      },
    );
    store.setRestore(s.terminalId, { terminal: true, codex: true, cwd: event.cwd });
    // Unread completion is independent of session activity. It survives new turns.
  } else if (event.type === 'codex-exited') {
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    s.ready = false;
    s.codexActive = false;
    s.status = 'shell';
    s.reportedThreadId = null;
    if (!quitting) store.setRestore(s.terminalId, { codex: false });
    const code = Number(event.exitCode);
    if (code && code !== 130 && code !== -1073741510) s.error = t('{agent} 已退出（代码 {code}），请查看终端输出。', { agent: s.agent === 'claude' ? 'Claude Code' : 'Codex', code });
  } else if (event.type === 'turn-complete') {
    // notify is inherited by child agents. It only requests a refresh; the
    // interactive parent's task lifecycle is the authority for completion.
    if (s.codexActive && (!s.rootThreadId || event.threadId === s.rootThreadId)) void s.activityMonitor?.poll();
    return;
  } else return;
  broadcast();
  if (event.type === 'shell-prompt') void resumeAfterPrompt(project, s);
}

async function resumeAfterPrompt(project, session) {
  const plan = restorePlans.get(session.terminalId);
  if (!plan || !session.ready || session.inputDirty) return;
  restorePlans.delete(session.terminalId);
  const restore = store.findTerminal(session.terminalId)?.record.restore;
  // Claude Code (local projects) resumes its own conversation, continuing an unfinished turn.
  if (restore?.agent === 'claude' && project.kind !== 'ssh') {
    if (!session.claudeAvailable || !plan.codex) return;
    try {
      const command = claudeResumeCommand(restore);
      if (sessions.get(session.terminalId) !== session || !session.ready || session.inputDirty || session.codexActive) return;
      store.expectCompletion(project.id, restore.interrupted === true);
      session.ready = false;
      session.terminal.write(command);
      broadcast();
    } catch (error) { session.error = `恢复会话失败：${error.message}`; broadcast(); }
    return;
  }
  if (!session.codexAvailable) return;
  try {
    const info = project.kind === 'ssh' ? await session.terminal.request('resume-info', { threadId: restore?.threadId }) : await recentSession(restore?.cwd || project.path, session.codexHome, restore?.threadId);
    // Legacy versions did not record which process owned a conversation. Open
    // that history, but do not submit work to a possibly still-running session.
    const remembered = info || (restore?.threadId ? { id: restore.threadId, state: 'unknown' } : null);
    const command = project.terminals?.length && !restore?.threadId ? 'codex\r' : resumeCommand(remembered && !plan.codex ? { ...remembered, state: 'unknown' } : remembered, plan.codex);
    if (command && sessions.get(session.terminalId) === session && session.ready && !session.inputDirty && !session.codexActive) {
      // Opening completed history is not new input. Only the automatic
      // continuation of interrupted work may produce another completion alert.
      store.expectCompletion(project.id, info?.state === 'interrupted' && plan.codex);
      session.ready = false;
      session.terminal.write(command);
      broadcast();
    }
  } catch (error) { session.error = `恢复会话失败：${error.message}`; broadcast(); }
}

function remoteFor(id) {
  const project = findProject(id);
  const session = sessions.get(id)?.terminal.connected ? sessions.get(id) : [...sessions.values()].find(item => item.projectId === project.id && item.terminal.connected);
  if (project.kind !== 'ssh' || !session || session.terminal.closed) throw new Error('请先启动终端，连接 SSH 服务器。');
  return session.terminal;
}

// Same label as project:git-status ("HEAD 1a2b3c4d" when detached), so the two sources never flip
// the header back and forth; broadcast only when the label actually changes.
function setBranch(id, branch) {
  if (!store.projects.some(item => item.id === id) || branches.get(id) === branch) return;
  branches.set(id, branch); broadcast();
}
function captureBranch(project) {
  if (project.kind === 'ssh') return;
  const git = (args, done) => execFile('git', ['-C', project.path, ...args], { windowsHide: true, timeout: 3000 }, (error, stdout) => done(error ? '' : stdout.trim()));
  git(['symbolic-ref', '--short', '-q', 'HEAD'], branch => {
    if (branch) setBranch(project.id, branch);
    else git(['rev-parse', 'HEAD'], head => setBranch(project.id, head ? `HEAD ${head.slice(0, 8)}` : ''));
  });
}

// Adds a local folder as a project and opens its terminal; an already open folder just returns its id.
function addLocalProject(folder, name) {
  const { project, added } = store.add(folder, name);
  if (added) {
    try { startTerminal(project.id); }
    catch (error) { startupErrors.set(project.id, error.message); }
  }
  return project.id;
}

function startTerminal(id) {
  const project = findProject(id);
  const old = sessions.get(id);
  if (old && old.status !== 'exited') return;
  if (old) disposeTerminal(id);
  if (process.platform !== 'win32') throw new Error('此版本的终端集成面向 Windows 10/11。');
  if (project.kind !== 'ssh' && !fs.existsSync(project.path)) throw new Error('项目目录不存在，请重新添加。');
  const sessionId = randomUUID();
  const sessionKey = randomUUID();
  const startPath = restorePlans.get(id)?.cwd || store.findTerminal(id)?.record.restore?.cwd || project.path;
  // Local terminals use the shell chosen in settings; SSH projects always run Bash on the server.
  const shellKind = project.kind === 'ssh' ? 'bash' : store.settings.shell === 'cmd' ? 'cmd' : 'powershell';
  const bootstrapFile = project.kind === 'ssh' ? null : path.join(runtimeDir, `${sessionId}.json`);
  if (bootstrapFile) fs.writeFileSync(bootstrapFile, JSON.stringify({
    projectId: id, projectPath: startPath, sessionKey, pipeName: eventServer.name,
    powershellPath, notifyPath: path.join(integrationDir, 'notify.ps1'), claudeHookPath: path.join(integrationDir, 'claude-hook.ps1'),
  }), { mode: 0o600 });
  const env = createTerminalEnvironment(process.env, bootstrapFile || '');
  if (project.kind === 'ssh' && !sshAskpassPath) {
    // Windows OpenSSH 8.1 cannot spawn an askpass executable under a Unicode
    // directory. The system temp volume provides an ASCII/short-path location
    // even when the workspace volume has 8.3 names disabled.
    sshAskpassDir = fs.mkdtempSync(path.join(app.getPath('temp'), 'project-grid-ssh-'));
    const helper = path.join(sshAskpassDir, 'ssh-askpass.exe');
    fs.copyFileSync(path.join(integrationDir, 'ssh-askpass.exe'), helper);
    try { sshAskpassPath = execFileSync(helper, ['--short-path', helper], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim(); }
    catch { sshAskpassPath = helper; }
  }
  const terminal = project.kind === 'ssh' ? new RemoteConnection({ ...project, id }, { integrationDir, auth: sshAuth, sessionKey, onEvent, codingPath: startPath, askpassPath: sshAskpassPath,
    onReady: info => { branches.set(project.id, String(info.branch || '').slice(0, 120)); broadcast(); },
  }) : shellKind === 'cmd' ? pty.spawn(cmdPath, ['/D', '/Q', '/K', path.join(integrationDir, 'bootstrap.cmd')], {
    name: 'xterm-256color', cols: 90, rows: 22, cwd: startPath, env, useConpty: true, useConptyDll: true,
  }) : pty.spawn(powershellPath, ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', path.join(integrationDir, 'bootstrap.ps1')], {
    name: 'xterm-256color', cols: 90, rows: 22, cwd: startPath, env, useConpty: true, useConptyDll: true,
  });
  const s = {
    terminal, terminalId: id, projectId: project.id, sessionId, sessionKey, bootstrapFile, status: 'starting', ready: false, shellKind,
    // Command Prompt reports its prompts through markers in its output instead of the event pipe.
    prompts: shellKind === 'cmd' ? new PromptMarkers() : null,
    tools: shellKind === 'cmd' ? { codex: onPath('codex', env), claude: onPath('claude', env) } : null,
    titles: new TerminalTitleTracker(), reportedThreadId: null,
    codexActive: false, codexAvailable: null, seq: 0, chunks: [], bytes: 0, pending: '',
    flushTimer: null, lastActivityAt: Date.now(), error: null, submissions: new SubmissionTracker(),
  };
  s.actions = new ActionLog(change => publishAction(s, change));
  sessions.set(id, s);
  store.setRestore(id, { terminal: true, ...(restorePlans.has(id) ? {} : { codex: false }) });
  startupErrors.delete(id);
  const flush = () => {
    clearTimeout(s.flushTimer); s.flushTimer = null;
    if (!s.pending) return;
    send('terminal:data', { id, sessionId, seq: ++s.seq, data: s.pending });
    s.pending = '';
  };
  s.flush = flush;
  terminal.onData(data => {
    if (sessions.get(id) !== s) return;
    if (s.prompts) for (const cwd of s.prompts.write(data)) {
      onEvent({ projectId: id, sessionKey, type: 'shell-prompt', sequence: (s.lastShellEventSequence || 0) + 1, cwd, codexAvailable: s.tools.codex, claudeAvailable: s.tools.claude,
        codexHome: env.CODEX_HOME || path.join(os.homedir(), '.codex') });
    }
    for (const threadId of s.titles.write(data)) {
      if (s.reportedThreadId !== threadId) {
        s.reportedThreadId = threadId;
        if (s.codexActive) { s.codexActivity = 'unknown'; s.activityInputAt = 0; store.setRestore(id, { threadId }); void s.activityMonitor?.poll(); }
      }
    }
    s.chunks.push(data); s.bytes += data.length; s.pending += data;
    while (s.bytes > 1024 * 1024 && s.chunks.length > 1) s.bytes -= s.chunks.shift().length;
    s.lastActivityAt = Date.now();
    if (s.pending.length > 65536) flush();
    else if (!s.flushTimer) s.flushTimer = setTimeout(flush, 16);
  });
  terminal.onExit(({ exitCode }) => {
    if (sessions.get(id) !== s) return;
    flush();
    s.status = 'exited'; s.ready = false; s.codexActive = false;
    s.activityMonitor?.stop(); s.activityMonitor = null; s.codexActivity = 'unknown';
    restorePlans.delete(id);
    if (exitCode) s.error = terminal.error || t('终端已退出（代码 {code}）。', { code: exitCode });
    if (!quitting && !exitCode) store.setRestore(id, { terminal: false, codex: false });
    if (bootstrapFile) fs.rmSync(bootstrapFile, { force: true });
    broadcast();
  });
  captureBranch(project);
  broadcast();
}

function disposeTerminal(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  clearTimeout(s.flushTimer); clearTimeout(s.actionTimer);
  s.activityMonitor?.stop();
  try { s.terminal.kill(); } catch { }
  if (s.bootstrapFile) fs.rmSync(s.bootstrapFile, { force: true });
}

function checkSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Rejected IPC sender');
  const url = event.senderFrame.url;
  if (!(devUrl ? url.startsWith(`${devUrl}/`) : url.startsWith('project-grid://app/'))) throw new Error('Rejected IPC origin');
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    checkSender(event);
    try { return { ok: true, value: await fn(...args) }; }
    // Errors from every module are written in Chinese; they reach the window in the chosen language.
    catch (error) { return { ok: false, error: t(String(error?.message || error)) }; }
  });
}
function listen(channel, fn) {
  ipcMain.on(channel, (event, ...args) => { try { checkSender(event); fn(...args); } catch (error) { report(error); } });
}

async function confirmTerminalClose(id, verb, all = false) {
  const project = findProject(id);
  const chosen = all ? [...sessions.values()].filter(item => item.projectId === project.id) : [sessions.get(id)].filter(Boolean);
  const count = chosen.filter(item => item.status !== 'exited').length;
  if (!count) return true;
  const result = await dialog.showMessageBox(window, {
    type: 'question', title: t(`${verb}${all ? '项目' : '终端'}`), message: t('{verb}“{name}”的 {count} 个终端？', { verb: t(verb), name: project.name, count }),
    detail: t('所选终端内的 Codex 和其他运行中的命令会被结束。项目文件会保留。'),
    buttons: [t('取消'), t(`确认${verb}`)], defaultId: 0, cancelId: 0,
  });
  return result.response === 1;
}

async function requestQuit() {
  if (!await allowEditorClose()) return false;
  const count = [...sessions.values()].filter(s => s.status !== 'exited').length;
  if (count) {
    const result = await dialog.showMessageBox(window, {
      type: 'question', message: t('退出并关闭 {count} 个终端？', { count }),
      detail: t('运行中的任务会被结束。若要让任务继续，请最小化窗口或关闭到系统托盘。'),
      buttons: [t('继续运行'), t('退出应用')], defaultId: 0, cancelId: 0,
    });
    if (result.response !== 1) return false;
  }
  quitting = true;
  app.quit();
  return true;
}

function allowEditorClose() {
  if (!editorDirty || !window || window.isDestroyed()) return Promise.resolve(true);
  if (editorCloseRequest) return editorCloseRequest.promise;
  showWindow();
  const id = randomUUID();
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const timer = setTimeout(() => { if (editorCloseRequest?.id === id) { editorCloseRequest = null; resolve(false); } }, 60000);
  editorCloseRequest = { id, promise, resolve: accepted => { clearTimeout(timer); editorCloseRequest = null; resolve(accepted); } };
  send('editor:request-close', id);
  return promise;
}

function affectsEditor(id, paths) {
  return editorDirty && editorFile?.id === id && paths.some(value => editorFile.path === value || editorFile.path.startsWith(value + '/'));
}

function registerIpc() {
  handle('agents:status', () => agents.getState());
  handle('agents:install', agent => agents.install(agent));
  handle('agents:open-node', () => shell.openExternal('https://nodejs.org/'));
  handle('ssh:info', () => getSSHInfo());
  handle('ssh:auth-pending', () => sshAuth.getPending());
  handle('ssh:auth-answer', (id, answer) => sshAuth.answer(id, answer));
  handle('workspace:add-ssh', input => {
    const configuration = getSSHInfo();
    const { project, added } = store.addSSH({ ...input, configFile: configuration.configExists ? configuration.configFile : null });
    if (added || !sessions.has(project.id) || sessions.get(project.id).status === 'exited') {
      try { startTerminal(project.id); } catch (error) { startupErrors.set(project.id, error.message); }
    }
    broadcast(); return project.id;
  });
  handle('updates:state', () => updateManager.getState());
  handle('updates:check', () => updateManager.check());
  handle('updates:download-page', () => shell.openExternal('https://github.com/noeigenstate/project-manager/releases/latest'));
  handle('updates:install', async () => {
    if (installingUpdate) return false;
    if (!updateManager.canInstall()) throw new Error('更新尚未下载完成。');
    installingUpdate = true;
    try {
      if (!await allowEditorClose()) { installingUpdate = false; return false; }
      const count = [...sessions.values()].filter(session => session.status !== 'exited').length;
      if (count) {
        const result = await dialog.showMessageBox(window, {
          type: 'question', title: t('重启并安装更新'), message: t('重启会关闭 {count} 个终端', { count }),
          detail: t('请先确认任务已经完成。取消后，下载好的更新会继续保留。'),
          buttons: [t('继续工作'), t('关闭终端并更新')], defaultId: 0, cancelId: 0,
        });
        if (result.response !== 1) { installingUpdate = false; return false; }
      }
      quitting = true;
      updateManager.install();
      return true;
    } catch (error) { quitting = false; installingUpdate = false; throw error; }
  });
  handle('workspace:state', publicState);
  handle('workspace:add', async () => {
    const result = await dialog.showOpenDialog(window, { title: t('添加项目文件夹（可多选）'), properties: ['openDirectory', 'multiSelections'] });
    if (result.canceled) return [];
    const ids = result.filePaths.map(folder => addLocalProject(folder));
    broadcast();
    return ids;
  });
  const recentProjects = () => store.recentProjects().map(item => ({ ...item, exists: fs.existsSync(item.path) }));
  handle('workspace:recent', recentProjects);
  // Only folders already in the history can be reopened this way; anything else goes through the folder picker.
  handle('workspace:add-recent', folder => {
    const entry = store.recentEntry(folder);
    if (!entry) throw new Error('这个项目不在最近列表里，请重新选择文件夹。');
    if (!fs.existsSync(entry.path)) throw new Error('文件夹已不存在，可以把它从最近列表中删除。');
    const id = addLocalProject(entry.path, entry.name); broadcast(); return id;
  });
  handle('workspace:forget-recent', folder => { store.forget(folder); return recentProjects(); });
  handle('workspace:clear-recent', () => { store.clearHistory(); return recentProjects(); });
  handle('workspace:remove', async id => {
    if (editorFile?.id === id && !await allowEditorClose()) return false;
    if (!await confirmTerminalClose(id, '移除', true)) return false;
    disposeProjectTerminals(findProject(id)); previewResources.closeProject(id); store.remove(id); branches.delete(id); broadcast(); return true;
  });
  handle('workspace:acknowledge', id => { findProject(id); store.acknowledge(id); broadcast(); });
  handle('workspace:reorder', ids => { store.reorderProjects(ids); broadcast(); });
  handle('workspace:settings', patch => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的设置。');
    const language = store.settings.language;
    store.updateSettings(patch); broadcast();
    if (store.settings.language !== language) trayMenu();
    if (patch.restoreSessions === false) restorePlans.clear();
  });
  handle('project:directory', (id, relativePath = '', offset = 0) => findProject(id).kind === 'ssh' ? remoteFor(id).request('directory', { path: relativePath, offset }) : listDirectory(findProject(id), relativePath, offset));
  handle('project:git-status', async id => {
    const project = findProject(id), status = await projectGit.read(project, 'status');
    const branch = status.repository ? status.detached ? `HEAD ${status.head.slice(0, 8)}` : status.branch : '';
    setBranch(id, branch);
    return status;
  });
  handle('project:git-history', (id, offset = 0) => projectGit.read(findProject(id), 'history', offset));
  handle('project:git-files', (id, hash) => projectGit.read(findProject(id), 'files', hash));
  // The changes of one file as hunks; staged compares the index with HEAD, otherwise the working tree with the index.
  handle('project:git-diff', (id, relative, options = {}) => projectGit.read(findProject(id), 'diff', { path: relative, staged: options?.staged === true, untracked: options?.untracked === true }));
  // Keeps (stages) or undoes (reverse) a hunk's patch; an editor holding the file must agree first.
  handle('project:git-apply', async (id, patch, options = {}) => {
    const relative = typeof options?.path === 'string' ? options.path : '';
    if (relative && affectsEditor(id, [relative]) && !await allowEditorClose()) return { applied: false };
    return projectGit.read(findProject(id), 'apply', { patch, reverse: options?.reverse === true, cached: options?.cached === true });
  });
  handle('project:git-confirm-revert', async (id, relative, count) => {
    findProject(id);
    const name = String(relative).slice(0, 500);
    const result = await dialog.showMessageBox(window, { type: 'question', title: t('还原更改'), message: count > 1 ? t('还原“{name}”的 {count} 处更改？', { name, count }) : t('还原“{name}”的这处更改？', { name }),
      detail: t('工作区里的这些修改会被丢弃，无法撤销。'), buttons: [t('取消'), t('还原')], defaultId: 0, cancelId: 0 });
    return result.response === 1;
  });
  handle('project:create-entry', (id, directory, name, kind) => fileOperations.create(findProject(id), directory, name, kind));
  handle('project:rename-entry', async (id, relative, name) => {
    if (affectsEditor(id, [relative]) && !await allowEditorClose()) throw new Error('已取消重命名。');
    return fileOperations.rename(findProject(id), relative, name);
  });
  handle('project:delete-entries', async (id, paths) => {
    if (Array.isArray(paths) && affectsEditor(id, paths) && !await allowEditorClose()) return { deleted: [] };
    return fileOperations.remove(findProject(id), paths);
  });
  handle('project:copy-entries', (id, paths) => fileOperations.copy(findProject(id), paths));
  handle('project:copy-paths', async (id, paths, format) => {
    const project = findProject(id);
    const revision = clipboardWrites.reserve();
    const remote = project.kind === 'ssh' && format === 'absolute' ? remoteFor(id) : null;
    if (remote) await remote.ready;
    const value = projectPaths(project, paths, format, remote?.info.root);
    if (!await clipboardWrites.commit(revision, () => clipboard.writeText(value))) return { count: 0, superseded: true };
    return { count: paths.length };
  });
  handle('project:paste-entries', (id, directory) => fileOperations.paste(findProject(id), directory));
  handle('files:progress', () => fileProgress);
  handle('files:cancel', () => fileOperations.cancel());
  handle('voice:state', () => voiceManager.getState());
  handle('voice:prepare', () => voiceManager.prepare());
  handle('voice:warm', () => voiceManager.warm());
  handle('voice:transcribe', audio => voiceManager.transcribe(audio));
  handle('speech:state', () => speechManager.getState());
  handle('speech:prepare', () => speechManager.prepare());
  handle('speech:speak', text => speechManager.speak(text));
  listen('files:focus', (id, focused) => { if (focused) { findProject(id); activeFileTree = id; activeTerminal = null; } else if (activeFileTree === id) activeFileTree = null; });
  handle('project:file', async (id, relativePath, pageIndex) => {
    const project = findProject(id);
    const preview = project.kind === 'ssh' ? await remoteFor(id).request('preview', { path: relativePath, page: pageIndex || 0 }) : await readProjectFile(project, relativePath, pageIndex);
    if (['image', 'html', 'markdown', 'video'].includes(preview.kind)) return { ...preview, ...previewResources.open(project, relativePath, preview.kind, preview.mimeType) };
    return preview;
  });
  handle('project:preview-close', id => previewResources.close(id));
  handle('project:save-file', async (id, relativePath, pageIndex, revision, content) => {
    const project = findProject(id), key = `${project.id}:${relativePath}`;
    if (fileSaves.has(key)) throw new Error('此文件正在保存，请稍候。');
    if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('本次编辑内容超过 1 MB，请分段保存。');
    fileSaves.add(key);
    try {
      const preview = project.kind === 'ssh'
        ? await remoteFor(id).request('save-file', { path: relativePath, page: pageIndex, revision, data: Buffer.from(content, 'utf8').toString('base64') })
        : await saveProjectFile(project, relativePath, pageIndex, revision, content);
      if (['html', 'markdown'].includes(preview.kind)) return { ...preview, ...previewResources.open(project, relativePath, preview.kind) };
      return preview;
    } finally { fileSaves.delete(key); }
  });
  handle('editor:confirm-close', async filename => {
    const result = await dialog.showMessageBox(window, { type: 'question', title: t('未保存的修改'), message: t('保存对“{name}”的修改？', { name: String(filename).slice(0, 500) }),
      buttons: [t('保存'), t('不保存'), t('取消')], defaultId: 0, cancelId: 2 });
    return ['save', 'discard', 'cancel'][result.response] || 'cancel';
  });
  listen('editor:dirty', (value, id, filename) => { editorDirty = value === true; editorFile = editorDirty && typeof id === 'string' && typeof filename === 'string' ? { id, path: filename } : null; });
  listen('editor:close-result', (id, accepted) => { if (editorCloseRequest?.id === id) editorCloseRequest.resolve(accepted === true); });
  handle('project:open-link', async (id, target) => {
    const project = findProject(id);
    if (project.kind === 'ssh' && !/^(https?:\/\/|www\.)/i.test(target)) {
      const remote = remoteFor(id); await remote.ready;
      let value = String(target);
      if (/^file:\/\//i.test(value)) value = decodeURIComponent(new URL(value).pathname);
      else if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/:[0-9]+(?::[0-9]+)?$/.test(value)) throw new Error('只支持网页链接和远程项目内文件。');
      for (const candidate of new Set([value, value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '')])) {
        const relative = path.posix.relative(remote.info.root, path.posix.resolve(remote.info.root, candidate));
        if (relative === '..' || relative.startsWith('../')) throw new Error('该链接指向远程项目目录之外。');
        try {
          const stat = await remote.request('stat', { path: relative });
          if (stat.directory) return { kind: 'directory', path: stat.realPath === '.' ? '' : stat.realPath };
          return { kind: 'file', path: relative };
        } catch (error) { if (candidate === value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/, '')) throw error; }
      }
    }
    const link = await resolveTerminalLink(findProject(id), target);
    if (link.kind === 'external') { await shell.openExternal(link.url); return { kind: 'external' }; }
    if (link.kind === 'directory') { const error = await shell.openPath(link.path); if (error) throw new Error(error); return { kind: 'external' }; }
    return link;
  });
  handle('project:open-video', async (id, relativePath) => {
    if (findProject(id).kind === 'ssh') throw new Error('远程视频请使用内置播放器，或先下载到本机再用系统播放器打开。');
    const resolved = await resolveProjectPath(findProject(id), relativePath);
    if (!VIDEO_TYPES[path.extname(resolved).toLowerCase()] || !(await fs.promises.stat(resolved)).isFile()) throw new Error('请选择一个视频文件。');
    const error = await shell.openPath(resolved); if (error) throw new Error(error);
  });
  handle('project:reveal', async id => {
    const project = findProject(id);
    if (project.kind === 'ssh') return { kind: 'directory', path: '' };
    const error = await shell.openPath(project.path); if (error) throw new Error(error);
    return { kind: 'external' };
  });
  handle('terminal:start', startTerminal);
  handle('terminal:add', id => {
    const project = findProject(id);
    if (!sessions.has(project.id) && !project.terminals?.length) { startTerminal(project.id); return project.id; }
    const terminalId = store.addTerminal(project.id);
    try { startTerminal(terminalId); return terminalId; }
    catch (error) { store.removeTerminal(terminalId); throw error; }
  });
  handle('terminal:close', async id => {
    if (!await confirmTerminalClose(id, '关闭')) return false;
    restorePlans.delete(id); disposeTerminal(id); store.removeTerminal(id); startupErrors.delete(id); broadcast(); return true;
  });
  handle('terminal:restart', async id => {
    if (!await confirmTerminalClose(id, '重启')) return false;
    restorePlans.delete(id);
    disposeTerminal(id); startTerminal(id); return true;
  });
  handle('terminal:actions', id => { findProject(id); return sessions.get(id)?.actions.list || []; });
  handle('terminal:attach', id => {
    findProject(id);
    const s = sessions.get(id);
    if (!s) return { sessionId: null, seq: 0, data: '' };
    s.flush();
    return { sessionId: s.sessionId, seq: s.seq, data: s.chunks.join('') };
  });
  listen('terminal:write', (id, data) => {
    if (typeof data !== 'string' || data.length > 1024 * 1024) return;
    const s = sessions.get(id);
    if (s && s.status !== 'exited') {
      const submitted = s.submissions.write(data);
      // Sending a new prompt means the last result has been read: clear the unviewed state before the next round.
      if (submitted && store.projects.find(p => p.id === s.projectId)?.unread) { store.acknowledge(s.projectId); scheduleState(); }
      if (submitted && s.codexActive) {
        store.expectCompletion(s.projectId);
        s.codexActivity = 'working'; s.activityInputAt = Date.now();
        scheduleState(); warmSpeech();
      }
      if (!s.codexActive && !isTerminalResponse(data)) {
        const wasReady = s.ready && !s.inputDirty;
        s.inputDirty = true; if (data.includes('\r') || data.includes('\n')) s.ready = false;
        if (wasReady) scheduleState();
      }
      s.terminal.write(data);
    }
  });
  listen('terminal:resize', (id, cols, rows) => {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 500 || rows > 250) return;
    const s = sessions.get(id);
    if (s && s.status !== 'exited') s.terminal.resize(cols, rows);
  });
  handle('clipboard:copy', async text => {
    if (typeof text !== 'string') throw new Error('无效的剪贴板内容。');
    await clipboardWrites.commit(clipboardWrites.reserve(), () => clipboard.writeText(text));
  });
  handle('clipboard:read', () => clipboard.readText());
  handle('terminal:paste', (id, text, sessionId) => {
    const session = sessions.get(id);
    if (!session || session.sessionId !== sessionId || ['starting', 'exited'].includes(session.status)) throw new Error('终端已变化或尚未就绪，请复制文字后手动粘贴。');
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('无效的文字。');
    send('terminal:paste', { id, sessionId, text });
  });
  listen('terminal:focus', (id, focused) => { if (sessions.has(id) && focused) { activeTerminal = id; activeFileTree = null; } else if (activeTerminal === id) activeTerminal = null; });
  listen('window:minimize', () => window.minimize());
  listen('window:maximize', () => window.isMaximized() ? window.unmaximize() : window.maximize());
  listen('window:fullscreen', () => { userFullScreen = !window.isFullScreen(); window.setFullScreen(userFullScreen); });
  listen('window:close', () => window.close());
  // Keep full screen chosen with the shortcut when returning to the overview.
  listen('window:focus-mode', enabled => { if (typeof enabled === 'boolean') window.setFullScreen(enabled || userFullScreen); });
  handle('app:quit', requestQuit);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(async () => {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    let shellIcon = path.join(root, 'assets/icon.ico');
    if (process.platform === 'win32') shellIcon = materializeIcon(shellIcon, app.getPath('userData'));
    if (process.platform === 'win32' && installed && !process.env.PROJECT_GRID_DATA_DIR) {
      try {
        const repaired = repairShortcuts({ shell, executable: process.execPath, iconSource: shellIcon, userData: app.getPath('userData'),
          programs: path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs'),
          commonPrograms: process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft/Windows/Start Menu/Programs') : null,
          desktop: app.getPath('desktop'), commonDesktop: process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null,
        });
        shellIcon = repaired.icon;
        if (repaired.changes.length) execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/ie4uinit.exe'), ['-show'], { windowsHide: true, timeout: 5000 }, () => {});
      } catch (error) { console.warn('Windows shortcut repair:', error.message); }
    }
    if (process.platform === 'win32' && app.isPackaged && !process.env.PROJECT_GRID_DATA_DIR) {
      try {
        const refreshed = refreshSearchIcons({ localAppData: process.env.LOCALAPPDATA, userData: app.getPath('userData'), iconSource: shellIcon });
        if (refreshed.changes.length) execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/ie4uinit.exe'), ['-show'], { windowsHide: true, timeout: 5000 }, () => {});
      } catch (error) { console.warn('Windows Search icon refresh:', error.message); }
    }
    store = new WorkspaceStore(path.join(app.getPath('userData'), 'workspace.json'));
    voiceManager = new VoiceManager({ directory: path.join(app.getPath('userData'), 'voice'), fetcher: (url, options) => electronNet.fetch(url, options), changed: state => send('voice:state', state) });
    // Download the offline model in the background after installation so dictation works on first use.
    // Waits for startup and session restore first; isolated test profiles skip the 239 MB download.
    speechManager = new SpeechManager({ directory: path.join(app.getPath('userData'), 'voice'), fetcher: (url, options) => electronNet.fetch(url, options), changed: state => send('speech:state', state), busy: roundsWorking });
    if (!process.env.PROJECT_GRID_DATA_DIR) setTimeout(() => { if (!quitting) voiceManager.prepare().catch(() => {}); }, 8000);
    // The natural voice for spoken notices downloads once, after voice input, while announcing is on.
    // Its model is loaded only while a round is being worked on (warmSpeech), not for an idle window.
    if (!process.env.PROJECT_GRID_DATA_DIR) setTimeout(() => { if (!quitting && store.settings.announce) speechManager.prepare().then(() => { if (roundsWorking()) return speechManager.warm(); }).catch(() => {}); }, 20000);
    fileOperations = new FileOperations({ integrationDir, cacheRoot: path.join(app.getPath('userData'), 'file-clipboard'), remote: remoteFor, clipboardWrites,
      trash: filename => shell.trashItem(filename),
      confirmDelete: async (project, paths) => (await dialog.showMessageBox(window, { type: 'question', title: t('删除文件'), message: t('删除 {count} 个文件或文件夹？', { count: paths.length }),
        detail: `${paths.slice(0, 5).join('\n')}${paths.length > 5 ? '\n…' : ''}\n\n${project.kind === 'ssh' ? t('远程文件会被永久删除。') : t('本地文件会移入回收站。')}`,
        buttons: [t('取消'), t('删除')], defaultId: 0, cancelId: 0 })).response === 1,
      progress: value => { fileProgress = value; send('files:progress', value); },
    });
    runtimeDir = fs.mkdtempSync(path.join(app.getPath('userData'), 'runtime-'));
    eventServer = await createEventServer(onEvent);
    sshAuth = await new SSHAuthServer(queue => send('ssh:auth-changed', queue)).start();
    updateManager = new UpdateManager({
      updater: isInstalledBuild(app.isPackaged, process.execPath) ? require('electron-updater').autoUpdater : null,
      version: app.getVersion(), onChange: state => {
        if (state.status === 'error' && installingUpdate) { installingUpdate = false; quitting = false; }
        send('updates:changed', state);
      },
    });
    protocol.handle('project-grid', request => {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('Not found', { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const resolved = path.resolve(root, 'dist', relative);
      if (!resolved.startsWith(path.resolve(root, 'dist') + path.sep)) return new Response('Forbidden', { status: 403 });
      return electronNet.fetch(pathToFileURL(resolved).toString());
    });
    protocol.handle('project-preview', async request => {
      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      try {
        const resource = await previewResources.resolve(request.url);
        return resourceResponse(resource, request);
      } catch { return new Response(t('文件不存在、超出项目范围，或预览已关闭。'), { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }); }
    });
    registerIpc();
    window = new BrowserWindow({
      width: 1500, height: 940, minWidth: 820, minHeight: 560,
      title: t('Project Grid · 项目矩阵'), backgroundColor: '#101216',
      frame: false, show: false, icon: path.join(root, 'assets/icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
    });
    if (process.platform === 'win32') window.setAppDetails({ appId: appUserModelId, appIconPath: shellIcon, appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${root}"`,
      relaunchDisplayName: process.env.PROJECT_GRID_DATA_DIR ? 'Project Grid Test' : !app.isPackaged ? 'Project Grid Dev' : installed ? 'Project Grid' : 'Project Grid Portable',
    });
    // Native fullscreen can temporarily mark a visible window as occluded.
    // Keep its live terminals and zoom painting; throttle only after hiding it.
    window.on('hide', () => window.webContents.setBackgroundThrottling(true));
    window.on('minimize', () => window.webContents.setBackgroundThrottling(true));
    window.on('show', () => window.webContents.setBackgroundThrottling(false));
    window.on('restore', () => window.webContents.setBackgroundThrottling(false));
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('context-menu', (_event, params) => {
      if (activeTerminal || (!params.isEditable && !params.selectionText)) return;
      const items = params.isEditable ? [
        { label: t('撤销'), role: 'undo' }, { label: t('重做'), role: 'redo' }, { type: 'separator' },
        { label: t('剪切'), role: 'cut' }, { label: t('复制'), role: 'copy' }, { label: t('粘贴'), role: 'paste' }, { type: 'separator' }, { label: t('全选'), role: 'selectAll' },
      ] : [{ label: t('复制'), role: 'copy' }];
      Menu.buildFromTemplate(items).popup({ window });
    });
    // A frameless window has no Edit menu accelerators. Explicitly retain
    // standard editing shortcuts for inputs, including SSH password fields.
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || activeTerminal || input.alt) return;
      // An app shortcut (Ctrl+Shift+N adds a project by default) reaches the window, which keeps the usual
      // editing meaning inside text boxes and runs the action elsewhere.
      if (isAppShortcut(input)) return;
      const key = input.key.toLowerCase();
      if (activeFileTree && (((input.control || input.meta) && ['a', 'c', 'v'].includes(key)) || ['delete', 'f2'].includes(key) || (key === 'insert' && (input.control || input.shift)))) return;
      let action;
      if (input.control || input.meta) action = { c: 'copy', x: 'cut', v: input.shift ? 'pasteAndMatchStyle' : 'paste', a: 'selectAll', z: input.shift ? 'redo' : 'undo', y: 'redo', insert: 'copy' }[key];
      else if (input.shift && key === 'insert') action = 'paste';
      if (action) { event.preventDefault(); window.webContents[action](); }
    });
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame && event.url !== 'about:blank' && !previewResources.hasUrl(event.url)) event.preventDefault();
    });
    const allowPlayerFullscreen = (contents, permission, details) => permission === 'fullscreen' && contents === window.webContents && details.isMainFrame === true;
    const isAppFrame = (contents, details) => contents === window.webContents && details.isMainFrame === true && (devUrl ? contents.getURL().startsWith(devUrl + '/') : contents.getURL().startsWith('project-grid://app/'));
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => callback(allowPlayerFullscreen(contents, permission, details) || permission === 'media' && isAppFrame(contents, details) && details.mediaTypes?.length > 0 && details.mediaTypes.every(type => type === 'audio')));
    window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) => allowPlayerFullscreen(contents, permission, details) || permission === 'media' && isAppFrame(contents, details) && details.mediaType === 'audio');
    window.once('ready-to-show', () => window.show());
    window.on('focus', () => { clearTimeout(attentionTimer); window.flashFrame(false); });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (!quitting && details.reason !== 'clean-exit') window.reload();
    });
    window.on('close', event => {
      if (quitting) return;
      event.preventDefault();
      if (store.settings.closeToTray && tray) window.hide();
      else requestQuit().catch(report);
    });
    tray = new Tray(nativeImage.createFromPath(path.join(root, 'assets/icon.png')));
    tray.setToolTip(t('Project Grid · 项目矩阵'));
    trayMenu();
    tray.on('click', () => showWindow());
    Menu.setApplicationMenu(null);
    for (const project of store.projects) captureBranch(project);
    await window.loadURL(devUrl || 'project-grid://app/index.html');
    updateIndicators();
    if (!process.env.PROJECT_GRID_DATA_DIR) updateManager.start();
    if (store.settings.restoreSessions && (!process.env.PROJECT_GRID_DATA_DIR || process.env.PROJECT_GRID_TEST_RESTORE === '1')) {
      const terminals = store.projects.flatMap(project => [project, ...(project.terminals || [])].filter(record => record.restore === null || record.restore?.terminal).map(record => ({ project, record })));
      terminals.forEach(({ project, record }, index) => {
        if (record.restore === null || record.restore.codex) restorePlans.set(record.id, { codex: record.restore?.codex === true, cwd: record.restore?.cwd });
        const timer = setTimeout(() => {
          if (quitting || !store.settings.restoreSessions || !store.findTerminal(record.id) || record.restore?.terminal === false) return;
          try { startTerminal(record.id); } catch (error) { restorePlans.delete(record.id); startupErrors.set(record.id, error.message); broadcast(); }
        }, index * 300);
        timer.unref?.();
      });
    }
  }).catch(error => {
    dialog.showErrorBox('Project Grid 无法启动', String(error?.stack || error));
    app.exit(1);
  });
}
app.on('before-quit', () => {
  clearTimeout(attentionTimer);
  voiceManager?.close(); speechManager?.close(); fileOperations?.cancel();
  quitting = true;
  updateManager?.dispose();
  clearTimeout(stateTimer);
  for (const id of sessions.keys()) disposeTerminal(id);
  sshAuth?.close();
  eventServer?.close();
  tray?.destroy();
  if (sshAskpassDir) {
    try { fs.rmSync(path.join(sshAskpassDir, 'ssh-askpass.exe'), { force: true }); fs.rmdirSync(sshAskpassDir); } catch { }
  }
  if (runtimeDir) {
    // Only this launch's generated, now-empty runtime directory is removed.
    try { fs.rmdirSync(runtimeDir); } catch { }
  }
});
app.on('window-all-closed', () => { if (quitting) app.quit(); });
