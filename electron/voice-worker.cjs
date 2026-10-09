// Runs the recognizer off the main thread: loading a model of hundreds of MB and decoding
// block for hundreds of milliseconds, which would otherwise stall terminal IPC.
const { parentPort, workerData } = require('node:worker_threads');
const sherpa = require('sherpa-onnx-node');

let engine;
function recognizer() {
  // workerData.model is the model part of the configuration, from MODELS in voice.cjs.
  engine ??= new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { ...workerData.model, numThreads: workerData.threads, provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
  });
  return engine;
}

parentPort.on('message', ({ id, samples, warm }) => {
  // Loading ahead of a recording; a failure is reported by the recognition that follows.
  if (warm) { try { recognizer(); } catch { } return; }
  try {
    const asr = recognizer();
    const stream = asr.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    asr.decode(stream);
    parentPort.postMessage({ id, text: asr.getResult(stream).text || '' });
  } catch (error) { parentPort.postMessage({ id, error: error.message || String(error) }); }
});
