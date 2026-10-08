// Started from a desktop launcher, the Dock or Explorer, this process lacks the proxy variables a desktop terminal
// exports (GNOME Terminal turns the GNOME system proxy into https_proxy and friends). Without them Claude Code and
// Codex connect directly and fail ("API Error: 403", "workspace routing discovery timed out"). Chromium reads the
// same system settings, so its answer for the agents' endpoints supplies the variables they and npm read.
const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
const ENDPOINTS = ['https://api.anthropic.com', 'https://chatgpt.com'];

// Chromium answers with a PAC-style list such as "PROXY 127.0.0.1:7897; DIRECT"; the first entry is the one it uses.
function proxyUrl(rules) {
  const [type, address] = String(rules || '').split(';')[0].trim().split(/\s+/);
  if (!address) return null;
  const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks5h', SOCKS5: 'socks5h', SOCKS4: 'socks4' }[type.toUpperCase()];
  return scheme ? `${scheme}://${address}` : null;
}

function hasProxy(env) {
  return Object.keys(env).some(key => PROXY_KEYS.includes(key.toUpperCase()) && env[key]);
}

// The variables to add to env for the resolved rules, or none when env already names a proxy or the system has none.
function systemProxyEnvironment(env, rules) {
  const url = hasProxy(env) ? null : rules.map(proxyUrl).find(Boolean);
  if (!url) return {};
  const names = url.startsWith('socks') ? ['ALL_PROXY'] : ['HTTPS_PROXY', 'HTTP_PROXY'];
  if (!Object.keys(env).some(key => key.toUpperCase() === 'NO_PROXY')) names.push('NO_PROXY');
  const added = {};
  for (const name of names) {
    const value = name === 'NO_PROXY' ? 'localhost,127.0.0.1,::1' : url;
    added[name] = value;
    added[name.toLowerCase()] = value;
  }
  return added;
}

async function adoptSystemProxy({ session, env = process.env, timeout = 3000 } = {}) {
  if (hasProxy(env)) return {};
  let timer;
  const rules = ENDPOINTS.map(() => 'DIRECT');
  const expired = new Promise(resolve => { timer = setTimeout(resolve, timeout); });
  const resolved = Promise.all(ENDPOINTS.map(async (url, index) => {
    try { rules[index] = await session.resolveProxy(url); } catch { }
  }));
  // Keep a successful lookup even when another endpoint times out.
  await Promise.race([resolved, expired]).finally(() => clearTimeout(timer));
  const added = systemProxyEnvironment(env, rules);
  Object.assign(env, added);
  return added;
}

module.exports = { proxyUrl, systemProxyEnvironment, adoptSystemProxy };
