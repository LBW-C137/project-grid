const { test } = require('node:test');
const assert = require('node:assert/strict');
const { translate, en } = require('../electron/i18n.cjs');

test('Chinese stays as written; English looks the phrase up and fills placeholders', () => {
  assert.equal(translate('zh', '添加项目'), '添加项目');
  assert.equal(translate('zh', '终端 {n}', { n: 2 }), '终端 2');
  assert.equal(translate('en', '添加项目'), 'Add project');
  assert.equal(translate('en', '终端 {n}', { n: 2 }), 'Terminal 2');
  assert.equal(translate('en', '没有这条词条'), '没有这条词条', 'a missing entry falls back to Chinese');
});

test('finished messages from other modules are matched against the placeholder entries', () => {
  assert.equal(translate('en', '正在删除：报告.txt'), 'Deleting: 报告.txt');
  assert.equal(translate('en', '下载失败（HTTP 503），请检查网络后重试。'), 'Download failed (HTTP 503). Check your network and try again.');
  // A captured part that is itself a known message is translated too.
  assert.equal(translate('en', '恢复会话失败：无效的 Claude Code 会话。'), 'Could not restore the session: Invalid Claude Code session.');
  assert.equal(translate('en', 'SSH 已断开（连接关闭），可重新连接。'), 'SSH disconnected (connection closed); you can reconnect.');
});

test('every English entry keeps the placeholders of its Chinese key', () => {
  for (const [key, value] of Object.entries(en)) {
    assert.deepEqual((value.match(/\{\w+\}/g) || []).sort(), (key.match(/\{\w+\}/g) || []).sort(), key);
    assert.ok(value.trim(), `empty translation for ${key}`);
  }
});
