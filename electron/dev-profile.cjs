const fs = require('node:fs');
const path = require('node:path');

// A development run keeps its own profile, so it never shares the installed app's single-instance lock.
// Its first launch starts from the installed app's projects and settings, but restores no terminal or agent
// session: the installed app may be running those very sessions at the same time.
function seedDevProfile(installedDir, devDir) {
  const target = path.join(devDir, 'workspace.json');
  if (fs.existsSync(target)) return false;
  let workspace;
  try { workspace = JSON.parse(fs.readFileSync(path.join(installedDir, 'workspace.json'), 'utf8')); } catch { return false; }
  const idle = restore => ({ ...(restore || {}), terminal: false, codex: false });
  workspace.projects = (Array.isArray(workspace.projects) ? workspace.projects : []).map(project => ({
    ...project, restore: idle(project.restore),
    ...(Array.isArray(project.terminals) ? { terminals: project.terminals.map(terminal => ({ ...terminal, restore: idle(terminal.restore) })) } : {}),
  }));
  fs.mkdirSync(devDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(workspace, null, 2));
  return true;
}

module.exports = { seedDevProfile };
