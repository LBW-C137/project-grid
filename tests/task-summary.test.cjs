const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeTask } = require('../electron/task-summary.cjs');

test('a spoken task name is the first sentence of the prompt, cut to a short phrase', () => {
  assert.equal(summarizeTask('给登录页加上验证码。然后跑一下测试'), '给登录页加上验证码');
  assert.equal(summarizeTask('Add a captcha to the login page. Then run the tests.'), 'Add a captcha to the login page');
  assert.equal(summarizeTask('把设置对话框右上角的关闭按钮删掉，并且更新所有相关的测试脚本和文档说明'), '把设置对话框右上角的关闭按钮删掉，并且更新所有相关的测试…');
  assert.equal(summarizeTask('refactor the voice input so that it works in every terminal and every split view we have'), 'refactor the voice input so that it works in every terminal and…');
});

test('code, links and paths are left out, and bare follow-ups give no summary', () => {
  assert.equal(summarizeTask('修复 `useProjectReorder` 里拖动结束的抖动 https://example.com/issue/1'), '修复 里拖动结束的抖动');
  assert.equal(summarizeTask('看看 C:\\Users\\me\\app\\main.cjs 这个文件的报错'), '看看 这个文件的报错');
  assert.equal(summarizeTask('```js\nconsole.log(1)\n```\n解释这段代码'), '解释这段代码');
  for (const prompt of ['继续', '继续。', 'continue', 'OK', '  ', null, undefined]) assert.equal(summarizeTask(prompt), '', String(prompt));
});
