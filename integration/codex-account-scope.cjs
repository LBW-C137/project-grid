// The wrappers classify the actual argv locally. Only the resulting capability
// crosses the event pipe; prompts, config values and credential values do not.
const HOME_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CODEX_HOME'];

function hasAccountOverrides(env) {
  return Object.keys(env).some(key => {
    const name = key.toUpperCase();
    return /^(?:OPENAI|CHATGPT|AZURE_OPENAI)_/.test(name)
      || name !== 'CODEX_HOME' && /^CODEX_.*(?:AUTH|TOKEN|KEY|PROVIDER|PROFILE|CONFIG|URL|ENDPOINT|GATEWAY|HOME)/.test(name);
  });
}

function accountEnvironment(env) {
  const names = new Map(Object.keys(env).map(key => [key.toUpperCase(), key]));
  return { version: 1, overridden: hasAccountOverrides(env), homes: Object.fromEntries(
    HOME_KEYS.map(key => [key, names.has(key) ? env[names.get(key)] : null])) };
}

const model = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,199}$/.test(value);
function modelConfig(value) {
  const equal = value.indexOf('=');
  if (equal < 0) return false;
  const key = value.slice(0, equal).trim();
  if (!['model', 'model_reasoning_effort', 'service_tier'].includes(key)) return false;
  let scalar = value.slice(equal + 1).trim();
  try {
    if (scalar.startsWith('"')) scalar = JSON.parse(scalar);
    else if (scalar.startsWith("'")) scalar = /^'[^'\r\n]*'$/.test(scalar) ? scalar.slice(1, -1) : null;
  } catch { return false; }
  if (typeof scalar !== 'string') return false;
  if (key === 'model') return model(scalar);
  return key === 'model_reasoning_effort' ? /^(?:none|minimal|low|medium|high|xhigh)$/.test(scalar)
    : /^(?:fast|priority|flex|default)$/.test(scalar);
}

function safeAccountArgs(args) {
  if (!Array.isArray(args) || args.length > 128 || args.some(value => typeof value !== 'string')) return false;
  let resume = false, positional = 0;
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '--') { positional += args.length - i - 1; break; } // literal prompt(s), never parsed
    let option, value;
    if (['-m', '--model', '-c', '--config'].includes(word)) { option = word; value = args[++i]; }
    else {
      const attached = /^(--model|--config)=(.*)$|^(-m|-c)=?(.+)$/.exec(word);
      if (attached) { option = attached[1] || attached[3]; value = attached[2] ?? attached[4]; }
    }
    if (option) {
      if (typeof value !== 'string' || (option === '-m' || option === '--model' ? !model(value) : !modelConfig(value))) return false;
      continue;
    }
    if (word === 'resume' && !resume && !positional) { resume = true; continue; }
    if (resume && ['--last', '--all'].includes(word)) continue;
    if (word.startsWith('-')) return false;
    ++positional; // opaque initial prompt, or resume's session id and prompt
  }
  return positional <= (resume ? 2 : 1);
}

function accountLaunch(args, env, baseline) {
  if (baseline?.version !== 1 || baseline.overridden !== false || !baseline.homes) return 'unavailable';
  const current = accountEnvironment(env);
  if (current.overridden || HOME_KEYS.some(key => !Object.hasOwn(baseline.homes, key) || current.homes[key] !== baseline.homes[key])) return 'unavailable';
  return safeAccountArgs(args) ? 'model-only-v1' : 'unavailable';
}

if (require.main === module) {
  let input = '', bytes = 0, done = false;
  const finish = value => { if (!done) { done = true; process.stdout.write(value, () => process.exit(0)); } };
  const timer = setTimeout(() => finish('unavailable'), 2000); timer.unref();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) finish('unavailable'); else input += chunk;
  });
  process.stdin.on('error', () => finish('unavailable'));
  process.stdin.on('end', () => {
    try { const value = JSON.parse(input); finish(accountLaunch(value.args, process.env, value.baseline)); }
    catch { finish('unavailable'); }
  });
}

module.exports = { accountEnvironment, accountLaunch, safeAccountArgs, hasAccountOverrides };
