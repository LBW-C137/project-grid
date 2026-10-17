const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const en = require('../electron/locales/en.json');

function activityMarkup(calls, language = 'zh', terminal = {}) {
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
    ...terminal,
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

test("Claude's weekly session reset explains it requires an exhausted 5-hour limit without disabling the button", () => {
  const render = (percent, left = null, language = 'zh', kind = 'session', agent = 'claude') => activityMarkup([], language, {
    agent, agentUsage: { limits: [{ minutes: 10080, percent: 100 }, ...(percent === undefined ? [] : [{ minutes: 300, percent }])], resets: { kind, left } },
  });
  const caption = '5 小时额度用完后可用 · 每周 1 次';
  for (const percent of [0, 6, 99.9]) {
    for (const left of [null, 1]) {
      const html = render(percent, left);
      assert.ok(html.includes(`<small>${caption}</small>`));
      assert.ok(html.includes(`title="${caption}。`));
      assert.doesNotMatch(html, /<button[^>]*disabled/);
      assert.match(html, /点击后有 10 秒可以取消/);
    }
  }
  const english = render(6, null, 'en');
  const translated = 'Available once the 5-hour limit is used up · once a week';
  assert.ok(english.includes(`<small>${translated}</small>`));
  assert.ok(english.includes(`title="${translated}.`));
  for (const percent of [100, undefined]) {
    assert.match(render(percent), /<small>每周可重置 1 次 5 小时额度<\/small>/);
    assert.match(render(percent, 1), /<small>本周还可重置 1 次<\/small>/);
    assert.match(render(percent), /title="重置 5 小时额度：每周 1 次/);
  }
  const used = render(6, 0);
  assert.match(used, /<small>没有可用的重置<\/small>/);
  assert.match(used, /<button[^>]*disabled/);
  assert.doesNotMatch(used, /5 小时额度用完后可用/);
  assert.doesNotMatch(render(6, null, 'zh', 'grants'), /5 小时额度用完后可用/);
  assert.doesNotMatch(render(6, null, 'zh', 'session', 'codex'), /5 小时额度用完后可用/);
});
