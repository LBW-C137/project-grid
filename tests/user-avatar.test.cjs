const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { renderToStaticMarkup } = require('react-dom/server');
const React = require('react');

function load() {
  const filename = path.join(__dirname, '../src/shared/UserAvatar.tsx'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = name => name === '@phosphor-icons/react' ? { User: () => React.createElement('svg') } : originalRequire(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return mod.exports;
}

test('the user mark is the person icon until an avatar is set, then a round image, and back', () => {
  const { UserAvatar, setUserAvatar } = load();
  const markup = () => renderToStaticMarkup(React.createElement(UserAvatar));
  assert.match(markup(), /^<svg/);
  const picture = 'data:image/webp;base64,UklGRg==';
  setUserAvatar(picture);
  assert.equal(markup(), `<img class="user-avatar" src="${picture}" alt="" draggable="false"/>`);
  setUserAvatar('');
  assert.match(markup(), /^<svg/);
});
