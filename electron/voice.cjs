const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');

// SenseVoice Small (int8) through sherpa-onnx: strong Mandarin accuracy, simplified output,
// and non-autoregressive decoding that turns a sentence into text in well under a second on CPU.
// The revision is pinned so a repository update can never change the verified bytes. The 2025-09-09
// re-export was rejected: with sherpa-onnx 1.13.8 it ignores language detection and inverse text normalization.
const REPOSITORY = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07';
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];
const MODEL_DIRECTORY = 'sense-voice-2024-07-17';
const MODEL_FILES = [
  { name: 'tokens.txt', size: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc' },
  { name: 'model.int8.onnx', size: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51' },
].map(file => ({ ...file, urls: HOSTS.map(host => `${host}/${REPOSITORY}/resolve/${REVISION}/${file.name}?download=true`) }));
const DOWNLOAD_BYTES = MODEL_FILES.reduce((total, file) => total + file.size, 0);
// Files from the previous Whisper engine, removed once so they stop occupying about 64 MB.
const LEGACY_ENTRIES = ['runtime', 'runtime.zip', 'runtime.zip.partial', 'model.bin', 'model.bin.partial', 'recordings'];

async function digest(filename) { const hash = createHash('sha256'); for await (const chunk of fs.createReadStream(filename)) hash.update(chunk); return hash.digest('hex'); }

async function downloadFrom(url, asset, filename, fetcher, signal, progress) {
  const partial = filename + '.partial';
  let offset = 0;
  try { offset = (await fsp.stat(partial)).size; } catch { }
  if (offset > asset.size) { await fsp.unlink(partial); offset = 0; }
  if (offset < asset.size) {
    const response = await fetcher(url, { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal });
    if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}），请检查网络后重试。`);
    if (response.status === 206) { if (!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('下载续传响应无效，请重试。'); }
    else offset = 0;
    const file = await fsp.open(partial, offset ? 'a' : 'w');
    try {
      for await (const value of response.body) {
        if (signal.aborted) throw new Error('下载已暂停。');
        if (offset + value.length > asset.size) throw new Error('下载文件大小不正确。');
        await file.writeFile(value); offset += value.length; progress(offset);
      }
    } finally { await file.close(); }
  }
  if (offset !== asset.size) throw new Error('下载中断，稍后会自动继续。');
  if (await digest(partial) !== asset.sha256) { await fsp.unlink(partial); throw new Error('下载文件校验失败，请重试。'); }
  await fsp.rename(partial, filename);
}

// Tries each mirror in turn. A partial file is shared between mirrors because every mirror
// serves identical bytes, and the final SHA-256 check rejects anything that is not.
async function downloadAsset(asset, filename, fetcher, signal, progress) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  try { if ((await fsp.stat(filename)).size === asset.size && await digest(filename) === asset.sha256) { progress(asset.size); return; } } catch { }
  let failure;
  for (const url of asset.urls || [asset.url]) {
    if (signal.aborted) break;
    try { return await downloadFrom(url, asset, filename, fetcher, signal, progress); }
    catch (error) { failure = error; }
  }
  throw failure || new Error('下载已暂停。');
}

function validateAudio(value) {
  const bytes = Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
  if (bytes.length < 44 || bytes.length > 20 * 1024 * 1024 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.toString('ascii', 12, 16) !== 'fmt ' || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 32000 || bytes.readUInt16LE(32) !== 2 || bytes.readUInt16LE(34) !== 16 || bytes.toString('ascii', 36, 40) !== 'data' || bytes.readUInt32LE(40) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new Error('录音数据无效，请重新录制。');
  if (bytes.length - 44 < 16000) throw new Error('录音太短，请说完后再停止。');
  return bytes;
}

function samplesFromWav(bytes) {
  const samples = new Float32Array((bytes.length - 44) / 2);
  for (let index = 0; index < samples.length; index++) samples[index] = bytes.readInt16LE(44 + index * 2) / 32768;
  return samples;
}

class VoiceManager {
  constructor({ directory, fetcher = fetch, changed = () => {} }) {
    Object.assign(this, { directory, fetcher, changed });
    this.modelDirectory = path.join(directory, MODEL_DIRECTORY);
    this.state = { phase: 'missing', ready: false, percent: 0, error: null, model: 'SenseVoice Small · 本地离线识别', downloadBytes: DOWNLOAD_BYTES };
    this.requests = new Map(); this.sequence = 0;
  }
  file(name) { return path.join(this.modelDirectory, name); }
  update(patch) { if (Object.keys(patch).every(key => this.state[key] === patch[key])) return; this.state = { ...this.state, ...patch }; this.changed({ ...this.state }); }
  async getState() {
    this.initialized ??= (async () => {
      await Promise.all(LEGACY_ENTRIES.map(name => fsp.rm(path.join(this.directory, name), { recursive: true, force: true }).catch(() => {})));
      try {
        // Size is enough at startup; the full hash already ran when each file was downloaded.
        for (const file of MODEL_FILES) if ((await fsp.stat(this.file(file.name))).size !== file.size) return;
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
        for (const file of MODEL_FILES) {
          await downloadAsset(file, this.file(file.name), this.fetcher, this.controller.signal, count => this.update({ percent: Math.floor((completed + count) / DOWNLOAD_BYTES * 100) }));
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
    if (this.worker) return this.worker;
    const threads = Math.min(4, Math.max(1, os.availableParallelism() - 2));
    this.worker = new Worker(path.join(__dirname, 'voice-worker.cjs'), { workerData: { model: this.file('model.int8.onnx'), tokens: this.file('tokens.txt'), threads } });
    this.worker.on('message', ({ id, text, error }) => {
      const request = this.requests.get(id); if (!request) return;
      this.requests.delete(id);
      if (error) request.reject(new Error(`本地识别失败：${error}`)); else request.resolve(text);
    });
    const fail = error => {
      for (const { reject } of this.requests.values()) reject(new Error(`本地识别引擎已停止：${error?.message || error}`));
      this.requests.clear(); this.worker = null;
    };
    this.worker.on('error', fail);
    this.worker.on('exit', code => { if (this.worker) fail(`退出代码 ${code}`); });
    return this.worker;
  }
  // SenseVoice detects the language itself and writes Chinese, including Cantonese, in simplified characters.
  async transcribe(audio) {
    await this.getState();
    if (!this.state.ready) throw new Error(this.state.phase === 'downloading' ? `语音模型正在下载（${this.state.percent}%），完成后即可使用。` : '语音模型尚未下载。');
    if (this.requests.size) throw new Error('正在识别上一段录音，请稍后。');
    const samples = samplesFromWav(validateAudio(audio));
    this.update({ phase: 'transcribing', error: null });
    try {
      const id = ++this.sequence;
      const raw = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.requests.delete(id); reject(new Error('识别超时，请缩短录音后重试。')); }, 2 * 60 * 1000);
        this.requests.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        this.engine().postMessage({ id, samples }, [samples.buffer]);
      });
      const text = raw.trim();
      if (!text) throw new Error('没有识别到文字，请靠近麦克风重试。');
      this.update({ phase: 'ready' }); return text;
    } catch (error) { this.update({ phase: 'ready', error: error.message }); throw error; }
  }
  // Shutdown: stop any download and fail pending recognitions before the worker goes away.
  close() {
    this.controller?.abort();
    for (const { reject } of this.requests.values()) reject(new Error('识别已取消。'));
    this.requests.clear();
    const worker = this.worker; this.worker = null; void worker?.terminate();
  }
}
module.exports = { VoiceManager, MODEL_DIRECTORY, MODEL_FILES, DOWNLOAD_BYTES, digest, downloadAsset, validateAudio, samplesFromWav };
