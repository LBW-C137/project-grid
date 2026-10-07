const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

// Local terminals on macOS run zsh with the user's own start-up files and Project Grid's integration
// (integration/zsh-integration.zsh). zsh reads its start-up files from ZDOTDIR, so that names a folder of
// stubs, and each stub sources the integration with its phase.
const ZSH = '/bin/zsh';
const shellQuote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Writes the stubs into folder (they name the integration by its path, which moves with the application).
function prepareZshStartup(folder, integrationDir) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const script = path.join(integrationDir, 'zsh-integration.zsh');
  for (const phase of ['zshenv', 'zprofile', 'zshrc']) {
    const file = path.join(folder, `.${phase}`), text = `builtin source ${shellQuote(script)} ${phase}\n`;
    try { if (fs.readFileSync(file, 'utf8') === text) continue; } catch { }
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
  return folder;
}

// The environment of one terminal: what the integration needs, plus a UTF-8 locale. Programs started from
// the Dock have no LANG, and zsh, git and Codex would then treat Chinese text as unknown bytes.
function zshEnvironment(env, { folder, socket, projectId, sessionKey, node, helper, startDir, locale }) {
  return {
    ...env,
    ...(!env.LANG && !env.LC_ALL && !env.LC_CTYPE ? { LANG: locale || 'en_US.UTF-8' } : {}),
    ZDOTDIR: folder, PROJECT_GRID_USER_ZDOTDIR: env.ZDOTDIR || '',
    PROJECT_GRID_SOCKET: socket, PROJECT_GRID_PROJECT_ID: projectId, PROJECT_GRID_SESSION_KEY: sessionKey,
    PROJECT_GRID_NODE: node, PROJECT_GRID_EVENT_HELPER: helper, PROJECT_GRID_START_DIR: startDir,
  };
}

// zh-Hans-CN -> zh_CN.UTF-8, the way Terminal sets LANG from the system language and region; a locale the
// system does not have falls back to en_US.UTF-8.
function terminalLocale(languages = [], exists = name => fs.existsSync(path.join('/usr/share/locale', name))) {
  for (const tag of languages) {
    const parts = String(tag).split(/[-_]/), language = parts[0]?.toLowerCase(), region = parts.slice(1).find(part => /^[A-Z]{2}$/i.test(part))?.toUpperCase();
    if (!/^[a-z]{2,3}$/.test(language || '')) continue;
    for (const name of [region && `${language}_${region}.UTF-8`, language === 'zh' && 'zh_CN.UTF-8', language === 'en' && 'en_US.UTF-8'].filter(Boolean)) if (exists(name)) return name;
  }
  return 'en_US.UTF-8';
}

// Programs started from the Dock or Finder get only the system PATH (/usr/bin:/bin:/usr/sbin:/sbin), while
// codex, claude and npm live in folders the user's login shell adds (Homebrew, nvm, ~/.local/bin). Asks that
// shell once and gives its PATH, or null. printenv prints the exported PATH the same way from any shell.
function loginShellPath({ shell = process.env.SHELL || ZSH, env = process.env, timeout = 10000, run = execFile } = {}) {
  const marker = '__PROJECT_GRID_PATH__';
  return new Promise(resolve => {
    try {
      run(shell, ['-ilc', `echo ${marker}; /usr/bin/printenv PATH; echo ${marker}`], { env, timeout, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (_error, stdout) => {
        const value = String(stdout || '').split(marker)[1]?.trim();
        resolve(value && !value.includes('\n') ? value : null);
      });
    } catch { resolve(null); }
  });
}

// The login shell's folders first, then any of the current ones it does not have.
function mergePath(login, current) {
  const folders = [...String(login || '').split(':'), ...String(current || '').split(':')].filter(Boolean);
  return [...new Set(folders)].join(':');
}

module.exports = { ZSH, prepareZshStartup, zshEnvironment, terminalLocale, loginShellPath, mergePath, shellQuote };
