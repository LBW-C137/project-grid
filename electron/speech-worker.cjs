// Runs MeloTTS off the main thread: loading takes seconds and each notice takes about as long
// to synthesize as to hear, which would otherwise stall terminal IPC.
const { parentPort, workerData } = require('node:worker_threads');
const sherpa = require('sherpa-onnx-node');

let engine;
function synthesizer() {
  engine ??= new sherpa.OfflineTts({
    model: {
      vits: { model: workerData.model, lexicon: workerData.lexicon, tokens: workerData.tokens, dictDir: workerData.dictDir },
      numThreads: workerData.threads, provider: 'cpu', debug: 0,
    },
    ruleFsts: workerData.ruleFsts,
    maxNumSentences: 1,
  });
  return engine;
}

parentPort.on('message', ({ id, text, speed }) => {
  try {
    const audio = synthesizer().generate({ text, sid: 0, speed });
    const samples = Float32Array.from(audio.samples);
    parentPort.postMessage({ id, samples, sampleRate: audio.sampleRate }, [samples.buffer]);
  } catch (error) { parentPort.postMessage({ id, error: error.message || String(error) }); }
});
