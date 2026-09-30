// Runs SenseVoice off the main thread: loading the 239 MB model and decoding
// block for hundreds of milliseconds, which would otherwise stall terminal IPC.
const { parentPort, workerData } = require('node:worker_threads');
const sherpa = require('sherpa-onnx-node');

let engine;
function recognizer() {
  engine ??= new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: workerData.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: workerData.tokens, numThreads: workerData.threads, provider: 'cpu', debug: 0,
    },
  });
  return engine;
}

parentPort.on('message', ({ id, samples }) => {
  try {
    const asr = recognizer();
    const stream = asr.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    asr.decode(stream);
    parentPort.postMessage({ id, text: asr.getResult(stream).text || '' });
  } catch (error) { parentPort.postMessage({ id, error: error.message || String(error) }); }
});
