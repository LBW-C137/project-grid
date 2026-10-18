const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

test('desktop smokes and manual tools with Chinese UI selectors pin Chinese in their persisted isolated fixtures', t => {
  const directory = path.join(__dirname, '../scripts');
  const checked = [];
  const manualTools = ['perf-probe.mjs', 'readme-shots.mjs'];
  for (const file of fs.readdirSync(directory).filter(file => /smoke.*\.mjs$/.test(file) || manualTools.includes(file))) {
    const text = fs.readFileSync(path.join(directory, file), 'utf8');
    if (!/(?:getByRole|getByText|getByLabel|locator)\([^\n]*[一-鿿]/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const fixtureSettings = [];
    function visit(node) {
      // Read only persisted startup fixtures, never import/run a desktop script.
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'fs.writeFile'
        && node.arguments[0]?.getText(source).includes("'workspace.json'")) {
        const json = node.arguments[1];
        assert.ok(ts.isCallExpression(json) && json.expression.getText(source) === 'JSON.stringify', file);
        const settings = json.arguments[0].properties.find(property => property.name?.getText(source) === 'settings');
        assert.ok(settings && ts.isObjectLiteralExpression(settings.initializer), `${file}: persisted settings`);
        fixtureSettings.push(settings.initializer);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(fixtureSettings.length, `${file}: no explicit isolated startup fixture`);
    assert.match(text, /AGENTRIX_DATA_DIR/, `${file}: uses isolated data directory`);
    for (const settings of fixtureSettings) {
      const language = settings.properties.find(property => property.name?.getText(source) === 'language');
      assert.ok(language && ts.isStringLiteral(language.initializer), `${file}: explicit language`);
      assert.equal(language.initializer.text, 'zh', file);
    }
    checked.push(file);
  }
  for (const file of manualTools) assert.ok(checked.includes(file), `${file}: manual fixture audited`);
  assert.ok(checked.length >= 26, `expected broad fixture coverage, checked ${checked.length}`);
  t.diagnostic(`Audited ${checked.length} isolated fixtures, including both manual tools.`);
});
