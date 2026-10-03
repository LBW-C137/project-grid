const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { downloadAsset } = require('./voice.cjs');

// Spoken completion notices with a natural young female voice: MeloTTS (Chinese and English, int8)
// through sherpa-onnx, offline once downloaded. It reads mixed text such as English project names
// inside a Chinese sentence. The revision and every file's SHA-256 are pinned, like the voice-input model.
const REPOSITORY = 'csukuangfj/vits-melo-tts-zh_en';
const REVISION = 'a0d5c6a264c0ef92d70d8661d8cc502d79627cd6';
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];
const SPEECH_DIRECTORY = 'melo-tts-zh-en';
const SPEECH_FILES = [
  { name: 'model.int8.onnx', size: 53517430, sha256: 'f085f5079e05f039b800aeb542f5253c26a303211b0c6465d0d9387977855a63' },
  { name: 'lexicon.txt', size: 6837671, sha256: '7236884b02435ac5d10cf69b4be40a61b45aa676b5300f0e412f185748fee528' },
  { name: 'tokens.txt', size: 655, sha256: 'd18664a7e12bd7ea1022ddaf951e534e136815016c5a809d6b64156bffb4369d' },
  { name: 'date.fst', size: 59154, sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718' },
  { name: 'number.fst', size: 64482, sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd' },
  { name: 'phone.fst', size: 88630, sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7' },
  { name: 'new_heteronym.fst', size: 21974, sha256: 'ca14b2127e27baa571664e4bb791e143e7425f56a6bc29db08d74f97e6aa4e29' },
  { name: 'dict/hmm_model.utf8', size: 519739, sha256: 'f17790586ac86dd048c8adffed052c4bd2b28ed0682972c1275e59040c0589a7' },
  { name: 'dict/idf.utf8', size: 5998717, sha256: 'dbd1e03d72b2263cc8d84a4304ed77677eed9e7deaf43a1a5133bbba9733b535' },
  { name: 'dict/jieba.dict.utf8', size: 5071204, sha256: '3043b77068e09c9904f27cad82f12b6ebe9dbdb5aeff3b25e45ab7f9c1122b55' },
  { name: 'dict/stop_words.utf8', size: 8974, sha256: 'b788b8a939d2e2fe079abd579ea98f12f9fb84370bfd0dddd81bb9381f7ab42c' },
  { name: 'dict/user.dict.utf8', size: 49, sha256: '495bbf49270408a1234690e1e6a97328f30a482a7a72aa769e8a12e8714b0c62' },
  { name: 'dict/pos_dict/char_state_tab.utf8', size: 327139, sha256: '28b7be1dd7369766a51445af4d42e9a2ba4bf374c13be5bc1ca7721e27271dbb' },
  { name: 'dict/pos_dict/prob_emit.utf8', size: 1687686, sha256: 'c33c4cb7edf3b3a5947df7209b6e9f267eae1f21335d9e2bd2521ea07105457a' },
  { name: 'dict/pos_dict/prob_start.utf8', size: 4347, sha256: '13623ea0e9300bdb597cb2da28770b7b385d6c0098d66e516083fb01b6bd5d96' },
  { name: 'dict/pos_dict/prob_trans.utf8', size: 124159, sha256: 'f22363e2307408293d180c6f9f6b5cb75879d52f722f7764fa2d3d0ae2400236' },
].map(file => ({ ...file, urls: HOSTS.map(host => `${host}/${REPOSITORY}/resolve/${REVISION}/${file.name}?download=true`) }));
const SPEECH_BYTES = SPEECH_FILES.reduce((total, file) => total + file.size, 0);
// A touch quicker than the model's own pace, which sounds slow and flat for a short notice.
const SPEED = 1.25;
// The loaded model holds about 200 MB. It is released once nothing has needed it for this long and no
// round is being worked on, and loaded again when the next round starts (warm), before that round can finish.
const IDLE_RELEASE = 10 * 60 * 1000;

// The lexicon has no full-width colon or similar marks; they become pauses it can read.
function speakableText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/[：:；;]/g, '，').replace(/[“”"「」『』]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

class SpeechManager {
  // busy: whether a round is being worked on, so its notice will be needed. worker: the synthesis script.
  constructor({ directory, fetcher = fetch, changed = () => {}, busy = () => false, idle = IDLE_RELEASE, worker = path.join(__dirname, 'speech-worker.cjs') }) {
    Object.assign(this, { directory: path.join(directory, SPEECH_DIRECTORY), fetcher, changed, busy, idle, workerFile: worker });
    this.state = { phase: 'missing', ready: false, percent: 0, error: null, downloadBytes: SPEECH_BYTES };
    this.requests = new Map(); this.sequence = 0;
  }
  file(name) { return path.join(this.directory, name); }
  update(patch) { if (Object.keys(patch).every(key => this.state[key] === patch[key])) return; this.state = { ...this.state, ...patch }; this.changed({ ...this.state }); }
  async getState() {
    this.initialized ??= (async () => {
      try {
        for (const file of SPEECH_FILES) if ((await fsp.stat(this.file(file.name))).size !== file.size) return;
        this.update({ phase: 'ready', ready: true, percent: 100 });
      } catch { }
    })();
    await this.initialized; return { ...this.state };
  }
  async prepare() {
    await this.getState();
    if (this.preparing) return this.preparing;
    if (this.state.ready) return this.getState();
    this.controller = new AbortController();
    this.update({ phase: 'downloading', error: null, percent: 0 });
    this.preparing = (async () => {
      try {
        let completed = 0;
        for (const file of SPEECH_FILES) {
          await downloadAsset(file, this.file(file.name), this.fetcher, this.controller.signal, count => this.update({ percent: Math.floor((completed + count) / SPEECH_BYTES * 100) }));
          completed += file.size;
        }
        this.update({ phase: 'ready', ready: true, percent: 100, error: null });
      } catch (error) {
        this.update({ phase: 'error', error: this.controller.signal.aborted ? '下载已暂停，下次启动会继续。' : error.message });
        throw error;
      } finally { this.preparing = null; }
      return { ...this.state };
    })();
    return this.preparing;
  }
  engine() {
    this.rest();
    if (this.worker) return this.worker;
    const threads = Math.min(4, Math.max(1, os.availableParallelism() - 2));
    const file = name => this.file(name);
    const worker = this.worker = new Worker(this.workerFile, { workerData: {
      model: file('model.int8.onnx'), lexicon: file('lexicon.txt'), tokens: file('tokens.txt'), dictDir: file('dict'),
      ruleFsts: ['date.fst', 'phone.fst', 'number.fst', 'new_heteronym.fst'].map(file).join(','), threads,
    } });
    worker.on('message', ({ id, samples, sampleRate, error }) => {
      const request = this.requests.get(id); if (!request) return;
      this.requests.delete(id);
      if (error) request.reject(new Error(`语音合成失败：${error}`)); else request.resolve({ samples, sampleRate });
    });
    // A released worker exits after its successor may have started; only the current one's end is a failure.
    const fail = error => {
      if (this.worker !== worker) return;
      for (const { reject } of this.requests.values()) reject(new Error(`语音合成已停止：${error?.message || error}`));
      this.requests.clear(); this.worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', code => fail(`退出代码 ${code}`));
    return worker;
  }
  // Counts the idle time again from now. When it runs out the worker and its model are released,
  // unless a notice is being made or a round is still being worked on.
  rest() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.requests.size || this.busy()) { this.rest(); return; }
      const worker = this.worker; this.worker = null; void worker?.terminate();
    }, this.idle);
    this.idleTimer.unref?.();
  }
  // Loads the model ahead of the next notice, which otherwise waits several seconds longer.
  async warm() {
    await this.getState();
    if (!this.state.ready) return;
    if (this.worker) this.rest(); else await this.speak('好').catch(() => {});
  }
  // Returns mono float samples for the renderer to play. Notices are short and rare; they queue.
  async speak(text) {
    await this.getState();
    if (!this.state.ready) throw new Error('语音播报模型尚未下载。');
    const line = speakableText(text);
    if (!line) throw new Error('没有可播报的文字。');
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('语音合成超时。')); }, 60 * 1000);
      this.requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.engine().postMessage({ id, text: line, speed: SPEED });
    });
  }
  close() {
    this.controller?.abort(); clearTimeout(this.idleTimer);
    for (const { reject } of this.requests.values()) reject(new Error('语音合成已取消。'));
    this.requests.clear();
    const worker = this.worker; this.worker = null; void worker?.terminate();
  }
}

module.exports = { SpeechManager, SPEECH_DIRECTORY, SPEECH_FILES, SPEECH_BYTES, speakableText };
