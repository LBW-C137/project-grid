// Stands in for the speech and recognition workers: answers at once, without loading a model.
const { parentPort } = require('node:worker_threads');
parentPort.on('message', ({ id, text, warm }) => {
  if (warm) return;
  parentPort.postMessage(text === undefined ? { id, text: 'heard' } : { id, samples: new Float32Array(8), sampleRate: 16000 });
});
