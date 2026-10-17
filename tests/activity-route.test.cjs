const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const en = require('../electron/locales/en.json');

function activityMarkup(calls, language = 'zh') {
  const filename = path.join(__dirname, '../src/features/agents/ActivityPane.tsx');
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = mod.require.bind(mod);
  mod.require = name => {
    if (name.endsWith('.css')) return {};
    if (name === '../../shared/i18n') return { t: (key, values = {}) => (language === 'en' ? en[key] ?? key : key).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '') };
    if (name === '../reading/model-name') return require('../src/features/reading/model-name.ts');
    if (name === '../terminal/terminal-screen') return { readScreen: () => null, subscribeScreen: () => () => {} };
    if (name === '../home/send-to-agent') return { sendToAgent: () => { throw new Error('render must not send input'); } };
    if (name === './reset-count') return require('../src/features/agents/reset-count.ts');
    if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => () => React.createElement('svg') });
    return original(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return renderToStaticMarkup(React.createElement(mod.exports.ActivityPane, { terminal: {
    id: 'placeholder', agent: 'claude', codexActive: true, prompts: [], agentSettings: { model: 'claude-opus-5-5', effort: 'xhigh', fast: false },
    agentUsage: { provider: 'Anthropic', limits: [], calls },
  } }));
}

test('the activity route hides empty calls, formats model names, counts and tasks, and marks running groups', () => {
  const empty = activityMarkup([]);
  assert.ok(empty.includes('Opus 5.5'));
  assert.ok(!empty.includes('调用的模型'));
  assert.ok(!activityMarkup(undefined).includes('activity-route-calls'));
  const calls = [
    { agent: 'Claude Code', provider: 'Anthropic', model: 'claude-sonnet-5-5', effort: null, fast: null, runs: 2, running: 1, tasks: ['Polish <card>', 'Check spacing'] },
    { agent: 'Codex', provider: 'OpenAI', model: 'gpt-6.1-sol', effort: 'high', fast: true, runs: 5, running: 0, tasks: ['parser.md'] },
  ];
  const html = activityMarkup(calls);
  for (const text of ['调用的模型', 'Sonnet 5.5', 'GPT-6.1-Sol', '子代理 ×2 · 1 个运行中', 'Codex 子任务 ×5 · 思考 high · 快速', 'title="Polish &lt;card&gt;\nCheck spacing"']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/class="activity-call-running"/g) || []).length, 1);
  const english = activityMarkup(calls, 'en');
  for (const text of ['Models called', 'Subagents ×2 · 1 running', 'Codex subtasks ×5 · effort high · Fast']) assert.ok(english.includes(text), text);
});
