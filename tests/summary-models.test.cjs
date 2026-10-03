const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PRESETS, chat, listModels, connection, endpointUrl, modelSummary, withoutThinking, SecretStore } = require('../electron/summary-models.cjs');

// A local server that speaks both protocols, as Ollama / vLLM and Anthropic do.
async function server(t, handler) {
  const requests = [];
  const instance = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const record = { method: request.method, url: request.url, headers: request.headers, body: body ? JSON.parse(body) : null }; requests.push(record);
      const { status = 200, json, text } = handler(record);
      response.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/html' }); response.end(json ? JSON.stringify(json) : text || '');
    });
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return { base: `http://127.0.0.1:${instance.address().port}`, requests };
}

test('an OpenAI-compatible server (Ollama, vLLM, a cloud API) is asked for one sentence', async t => {
  const { base, requests } = await server(t, request => request.url === '/v1/models'
    ? { json: { data: [{ id: 'qwen2.5:1.5b' }, { id: 'gemma2:2b' }] } }
    : { json: { choices: [{ message: { role: 'assistant', content: '<think>先想想…</think>\n“登录页已加上验证码，测试全过。”' } }] } });
  const entry = { provider: 'ollama', baseUrl: `${base}/v1/`, model: 'qwen2.5:1.5b' };
  assert.deepEqual(await listModels({ ...connection('local', entry, '') }), ['qwen2.5:1.5b', 'gemma2:2b']);
  const summary = await modelSummary({ target: 'local', entry, apiKey: '', language: 'zh', task: '加验证码', reply: '我加了验证码，测试通过。' });
  assert.equal(summary, '登录页已加上验证码，测试全过。', 'thinking and quotes are not spoken');
  const call = requests.find(request => request.method === 'POST');
  assert.equal(call.url, '/v1/chat/completions'); assert.equal(call.headers.authorization, undefined, 'a local server gets no key unless one is set');
  assert.equal(call.body.model, 'qwen2.5:1.5b'); assert.equal(call.body.stream, false);
  assert.deepEqual(call.body.messages.map(message => message.role), ['system', 'user']);
  assert.ok(call.body.messages[1].content.includes('<助手最终回复>') && call.body.messages[1].content.includes('我加了验证码'));
  await modelSummary({ target: 'cloud', entry: { provider: 'custom', baseUrl: base + '/v1', model: 'm' }, apiKey: 'sk-test', language: 'en', task: '', reply: 'done' });
  assert.equal(requests.at(-1).headers.authorization, 'Bearer sk-test');
});

test('Anthropic is asked through its own protocol, with the key in its own header', async t => {
  const { base, requests } = await server(t, () => ({ json: { content: [{ type: 'text', text: 'Fixed the flaky test; all runs pass.' }] } }));
  const text = await chat({ protocol: 'anthropic', baseUrl: base, model: 'claude-haiku-4-5-20251001', apiKey: 'key', system: 'S', prompt: 'P' });
  assert.equal(text, 'Fixed the flaky test; all runs pass.');
  assert.equal(requests[0].url, '/v1/messages'); assert.equal(requests[0].headers['x-api-key'], 'key'); assert.equal(requests[0].headers['anthropic-version'], '2023-06-01');
  assert.deepEqual([requests[0].body.system, requests[0].body.messages], ['S', [{ role: 'user', content: 'P' }]]);
  await assert.rejects(chat({ protocol: 'anthropic', baseUrl: base, model: 'm', apiKey: '', system: 'S', prompt: 'P' }), /请先填写 API 密钥/);
});

test('failures say what went wrong: a bad key, a missing model, a wrong address, no answer in time', async t => {
  const { base } = await server(t, request => request.body?.model === 'denied' ? { status: 401, json: { error: { message: 'invalid api key' } } }
    : request.body?.model === 'missing' ? { status: 404, json: { error: { message: 'model "missing" not found' } } }
    : request.body?.model === 'html' ? { text: '<html>not an API</html>' }
    : { json: { choices: [{ message: { content: '   ' } }] } });
  const ask = model => modelSummary({ target: 'local', entry: { provider: 'custom', baseUrl: base, model }, apiKey: '', language: 'zh', task: '', reply: 'r' });
  await assert.rejects(ask('denied'), /API 密钥无效或没有权限（HTTP 401）/);
  await assert.rejects(ask('missing'), /接口地址或模型不存在（HTTP 404）：model "missing" not found/);
  await assert.rejects(ask('html'), /返回的不是 JSON/);
  await assert.rejects(ask('empty'), /没有给出可用的总结/);
  await assert.rejects(ask(''), /请填写模型名称/);
  await assert.rejects(modelSummary({ target: 'local', entry: { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'm' }, apiKey: '', language: 'zh', task: '', reply: 'r' }), /连接不上模型接口/);
  await assert.rejects(chat({ baseUrl: base, model: 'm', system: 'S', prompt: 'P', timeout: 20, fetcher: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) }), /超时/);
});

test('addresses are checked: cloud APIs are https, local servers may be plain http, nothing carries credentials', () => {
  assert.equal(endpointUrl('local', ' http://192.168.1.20:8000/v1/ '), 'http://192.168.1.20:8000/v1');
  assert.equal(endpointUrl('cloud', 'https://api.anthropic.com'), 'https://api.anthropic.com');
  assert.equal(endpointUrl('cloud', 'http://localhost:4000/v1'), 'http://localhost:4000/v1', 'a local gateway is fine for the cloud entry');
  assert.throws(() => endpointUrl('cloud', 'http://api.example.com/v1'), /https/);
  for (const bad of ['', 'localhost:11434', 'file:///etc/passwd', 'https://user:pass@api.example.com']) assert.throws(() => endpointUrl('local', bad), /接口地址无效/);
  assert.equal(connection('cloud', { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'm', protocol: 'openai' }).protocol, 'anthropic', 'a preset decides its own protocol');
  assert.equal(connection('cloud', { provider: 'custom', baseUrl: 'https://x.example', model: 'm', protocol: 'anthropic' }).protocol, 'anthropic');
  assert.throws(() => connection('remote', {}), /无效的模型类型/);
  assert.ok(PRESETS.cloud.every(item => item.id === 'custom' || endpointUrl('cloud', item.baseUrl)) && PRESETS.local.every(item => item.id === 'custom' || endpointUrl('local', item.baseUrl)));
  assert.equal(withoutThinking('reasoning…</think>答案'), '答案', 'a reply that only closes its thinking is handled too');
});

test('API keys are stored encrypted, apart from the settings, and are never handed back in the clear on disk', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-keys-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'summary-keys.json');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from([...text].reverse().join(''), 'utf8'), decryptString: buffer => [...buffer.toString('utf8')].reverse().join('') };
  const store = new SecretStore(file, safeStorage);
  assert.equal(store.has('cloud'), false); assert.equal(store.get('cloud'), '');
  store.set('cloud', ' sk-secret-123 ');
  assert.equal(store.has('cloud'), true); assert.equal(store.get('cloud'), 'sk-secret-123');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sk-secret-123'), 'the file does not hold the key as typed');
  assert.equal(new SecretStore(file, safeStorage).get('cloud'), 'sk-secret-123', 'it survives a restart');
  store.set('cloud', ''); assert.equal(store.has('cloud'), false);
  assert.throws(() => store.set('other', 'x'), /无效的模型类型/); assert.throws(() => store.set('local', 'two words'), /格式不正确/);
  assert.throws(() => new SecretStore(file, { ...safeStorage, isEncryptionAvailable: () => false }).set('local', 'k'), /无法加密/);
});
