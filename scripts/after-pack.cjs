// electron-builder afterPack hook: drop Chromium's DirectX shader compiler (about 26 MB unpacked).
// Only WebGPU on D3D12 loads it; Project Grid draws with ANGLE/D3D11, which uses d3dcompiler_47.dll.
// Verified before removal: identical app.getGPUFeatureStatus() and passing packaged material/visual
// smoke tests (backdrop blur, SVG refraction, 16 cards at 60 fps) without these files.
const fs = require('node:fs/promises');
const path = require('node:path');

exports.default = async context => {
  if (context.electronPlatformName !== 'win32') return;
  for (const name of ['dxcompiler.dll', 'dxil.dll']) await fs.rm(path.join(context.appOutDir, name), { force: true });
};
