const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SpeechManager, SPEECH_DIRECTORY, SPEECH_FILES, SPEECH_BYTES, speakableText } = require('../electron/speech.cjs');

test('notices become text the voice can read: colons and quotes turn into pauses, length is bounded', () => {
  assert.equal(speakableText('界面开发：给“登录页”加上验证码'), '界面开发，给登录页加上验证码');
  assert.equal(speakableText('project-manager: done'), 'project-manager， done');
  assert.equal(speakableText('x'.repeat(500)).length, 200);
  assert.equal(speakableText(null), '');
});

test('the natural voice is pinned by revision, size and SHA-256, and reports ready only when every file is present', async t => {
  assert.ok(SPEECH_FILES.every(file => /^[a-f\d]{64}$/.test(file.sha256) && file.size > 0 && file.urls.every(url => url.includes('/resolve/a0d5c6a264c0ef92d70d8661d8cc502d79627cd6/'))));
  assert.ok(SPEECH_BYTES > 70e6 && SPEECH_BYTES < 80e6, 'about 74 MB');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-grid-speech-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = new SpeechManager({ directory });
  assert.equal((await missing.getState()).ready, false);
  await assert.rejects(missing.speak('你好'), /尚未下载/);
  for (const file of SPEECH_FILES) {
    const target = path.join(directory, SPEECH_DIRECTORY, file.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.closeSync(fs.openSync(target, 'w')); fs.truncateSync(target, file.size);
  }
  const present = new SpeechManager({ directory });
  assert.equal((await present.getState()).phase, 'ready');
  await assert.rejects(present.speak('   '), /没有可播报的文字/);
});
