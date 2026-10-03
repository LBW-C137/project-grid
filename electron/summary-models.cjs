const fs = require('node:fs');
const path = require('node:path');
const PRESETS = require('./summary-presets.json');
const { SYSTEM, summaryPrompt, cleanSummary } = require('./round-summary.cjs');

// The spoken summary can also come from a model reached over HTTP: a cloud API with a key, or a small
// model served on this machine or the local network (Ollama, vLLM, LM Studio, llama.cpp). Nearly all of
// them speak the OpenAI chat-completions protocol; Anthropic has its own. Requests are made by the main
// process only, and the API key never reaches the window.
const TARGETS = ['cloud', 'local'];
const presetFor = (target, id) => PRESETS[target].find(item => item.id === id) || PRESETS[target].at(-1);

// The address of the API as typed, without a trailing slash. A cloud API must be https; a local server
// may be plain http, on this machine or another one on the network.
function endpointUrl(target, value) {
  let url; try { url = new URL(String(value || '').trim()); } catch { throw new Error('接口地址无效，请填写完整地址，例如 http://localhost:11434/v1'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址无效，请填写完整地址，例如 http://localhost:11434/v1');
  if (target === 'cloud' && url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('云端接口必须使用 https 地址。');
  return (url.origin + url.pathname).replace(/\/+$/, '');
}

// Small models that reason before answering put that in <think> tags; only the answer is spoken.
const withoutThinking = text => String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '').trim();

async function request(fetcher, url, { method = 'GET', headers = {}, body, timeout }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(url, { method, headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('模型接口返回的内容过大。');
    let data = null; try { data = JSON.parse(text); } catch { }
    if (!response.ok) {
      const detail = typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || text.slice(0, 200);
      throw new Error(response.status === 401 || response.status === 403 ? `API 密钥无效或没有权限（HTTP ${response.status}）。` : response.status === 404 ? `接口地址或模型不存在（HTTP 404）：${String(detail).slice(0, 200)}` : `模型接口返回错误（HTTP ${response.status}）：${String(detail).slice(0, 200)}`);
    }
    if (!data) throw new Error('模型接口返回的不是 JSON，请检查接口地址。');
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('模型接口超时，没有在限定时间内回答。');
    if (/^(API 密钥|接口地址|模型接口)/.test(error.message)) throw error;
    throw new Error(`连接不上模型接口：${String(error.cause?.code || error.cause?.message || error.message).slice(0, 160)}`);
  } finally { clearTimeout(timer); }
}

// One chat turn: the summariser's instructions and the material in, the model's text out.
async function chat({ protocol = 'openai', baseUrl, model, apiKey = '', system, prompt, fetcher = fetch, timeout = 30000 }) {
  if (!model) throw new Error('请填写模型名称。');
  if (protocol === 'anthropic') {
    if (!apiKey) throw new Error('请先填写 API 密钥。');
    const data = await request(fetcher, `${baseUrl}/v1/messages`, { method: 'POST', timeout, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: { model, max_tokens: 200, system, messages: [{ role: 'user', content: prompt }] } });
    return withoutThinking((data.content || []).filter(block => block.type === 'text').map(block => block.text).join(''));
  }
  const data = await request(fetcher, `${baseUrl}/chat/completions`, { method: 'POST', timeout, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: { model, stream: false, temperature: 0.2, max_tokens: 400, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] } });
  const message = data.choices?.[0]?.message;
  return withoutThinking(typeof message?.content === 'string' ? message.content : Array.isArray(message?.content) ? message.content.map(part => part.text || '').join('') : '');
}

// The models the server offers, for the model field's suggestions.
async function listModels({ protocol = 'openai', baseUrl, apiKey = '', fetcher = fetch, timeout = 10000 }) {
  const data = protocol === 'anthropic'
    ? await request(fetcher, `${baseUrl}/v1/models`, { timeout, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } })
    : await request(fetcher, `${baseUrl}/models`, { timeout, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
  return (Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : []).map(item => String(item.id || item.name || '')).filter(Boolean).slice(0, 500);
}

// The connection a settings entry describes: { provider, baseUrl, model } plus the preset's protocol.
function connection(target, entry, apiKey) {
  if (!TARGETS.includes(target)) throw new Error('无效的模型类型。');
  const preset = presetFor(target, entry?.provider);
  return { protocol: preset.id === 'custom' && entry?.protocol === 'anthropic' ? 'anthropic' : preset.protocol, baseUrl: endpointUrl(target, entry?.baseUrl || preset.baseUrl), model: String(entry?.model || '').trim(), apiKey: apiKey || '' };
}

// The sentence for the spoken notice from an HTTP model. Throws with a message for the settings page;
// the notice path catches it and speaks the plain notice.
async function modelSummary({ target, entry, apiKey, language, task, reply, fetcher, timeout }) {
  const answer = await chat({ ...connection(target, entry, apiKey), system: SYSTEM, prompt: summaryPrompt({ language, task, reply }), fetcher, timeout: timeout || (target === 'local' ? 45000 : 25000) });
  const summary = cleanSummary(answer, language);
  if (!summary) throw new Error('模型没有给出可用的总结。');
  return summary;
}

// API keys, encrypted by the operating system (DPAPI on Windows) and kept apart from the workspace
// file. A key is written and used here; nothing gives it back.
class SecretStore {
  constructor(filename, safeStorage) { this.filename = filename; this.safeStorage = safeStorage; this.values = {}; try { this.values = JSON.parse(fs.readFileSync(filename, 'utf8')) || {}; } catch { } }
  has(name) { return typeof this.values[name] === 'string' && this.values[name].length > 0; }
  get(name) {
    if (!this.has(name)) return '';
    try { return this.safeStorage.decryptString(Buffer.from(this.values[name], 'base64')); } catch { return ''; }
  }
  set(name, secret) {
    if (!TARGETS.includes(name)) throw new Error('无效的模型类型。');
    const value = String(secret || '').trim();
    if (value.length > 400 || /[\s\0]/.test(value)) throw new Error('API 密钥格式不正确。');
    if (!value) delete this.values[name];
    else {
      if (!this.safeStorage.isEncryptionAvailable()) throw new Error('此系统无法加密保存密钥，未保存。');
      this.values[name] = this.safeStorage.encryptString(value).toString('base64');
    }
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename, JSON.stringify(this.values), { mode: 0o600 });
  }
}

module.exports = { PRESETS, TARGETS, chat, listModels, connection, endpointUrl, modelSummary, withoutThinking, SecretStore };
