const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { brotliDecompressSync, gunzipSync } = require('node:zlib');
const manifest = require('./electron-pak-trim.json');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const regenerateHelp = 'Verify the official Electron ZIPs against SHASUMS256.txt, then run '
  + 'node scripts/trim-electron-pak.cjs --regenerate <electron-version> <platform-arch> <resources.pak> '
  + 'for each supported platform. Review and merge the entries into scripts/electron-pak-trim.json.';

function readPak(data) {
  if (data.length < 12 || data.readUInt32LE(0) !== 5 || data[4] > 2) throw new Error('Expected a GRIT PAK v5 file');
  const count = data.readUInt16LE(8), aliasCount = data.readUInt16LE(10);
  const aliasOffset = 12 + (count + 1) * 6, indexEnd = aliasOffset + aliasCount * 4;
  if (data.length < indexEnd || data.readUInt32LE(14) !== indexEnd) throw new Error('Invalid PAK index');
  if (data.readUInt16LE(12 + count * 6) !== 0 || data.readUInt32LE(14 + count * 6) !== data.length) throw new Error('Invalid PAK sentinel');
  const physical = [], resources = new Map();
  let previousId = 0;
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 6, id = data.readUInt16LE(at);
    const start = data.readUInt32LE(at + 2), end = data.readUInt32LE(at + 8);
    if (id <= previousId || start < indexEnd || end < start || end > data.length) throw new Error('Invalid PAK resource');
    const value = data.subarray(start, end);
    physical.push(value);
    resources.set(id, value);
    previousId = id;
  }
  previousId = 0;
  for (let index = 0; index < aliasCount; index++) {
    const at = aliasOffset + index * 4, id = data.readUInt16LE(at), target = data.readUInt16LE(at + 2);
    if (id <= previousId || target >= count || resources.has(id)) throw new Error('Invalid PAK alias');
    resources.set(id, physical[target]);
    previousId = id;
  }
  return { encoding: data[4], resources };
}

function writePak(encoding, resources) {
  const byContent = new Map();
  for (const [id, value] of [...resources].sort((a, b) => a[0] - b[0])) {
    const digest = sha256(value), same = byContent.get(digest);
    if (!same) { byContent.set(digest, { id, value, aliases: [] }); continue; }
    if (!same.value.equals(value)) throw new Error('PAK resource SHA-256 collision');
    same.aliases.push(id);
  }
  const physical = [...byContent.values()];
  const aliases = physical.flatMap((entry, index) => entry.aliases.map(id => ({ id, index }))).sort((a, b) => a.id - b.id);
  const indexEnd = 12 + (physical.length + 1) * 6 + aliases.length * 4;
  const data = Buffer.alloc(indexEnd + physical.reduce((total, entry) => total + entry.value.length, 0));
  data.writeUInt32LE(5, 0);
  data[4] = encoding;
  data.writeUInt16LE(physical.length, 8);
  data.writeUInt16LE(aliases.length, 10);
  let offset = indexEnd;
  physical.forEach((entry, index) => {
    data.writeUInt16LE(entry.id, 12 + index * 6);
    data.writeUInt32LE(offset, 14 + index * 6);
    entry.value.copy(data, offset);
    offset += entry.value.length;
  });
  data.writeUInt32LE(offset, 14 + physical.length * 6);
  aliases.forEach((entry, index) => {
    const at = 12 + (physical.length + 1) * 6 + index * 4;
    data.writeUInt16LE(entry.id, at);
    data.writeUInt16LE(entry.index, at + 2);
  });
  return data;
}

function rewritePak(data, groups) {
  const original = readPak(data), kept = new Map(original.resources);
  for (const group of ['intro-sounds', 'devtools', 'tracing']) {
    if (!Array.isArray(groups?.[group]) || !groups[group].length) throw new Error(`Missing PAK trim group: ${group}`);
    for (const id of groups[group]) {
      if (!kept.delete(id)) throw new Error(`Missing or repeated PAK trim resource: ${id}`);
    }
  }
  if (Object.keys(groups).length !== 3) throw new Error('Unexpected PAK trim group');
  const output = writePak(original.encoding, kept), check = readPak(output);
  if (check.resources.size !== kept.size || check.encoding !== original.encoding) throw new Error('PAK rewrite verification failed');
  for (const [id, value] of kept) {
    if (!check.resources.get(id)?.equals(value)) throw new Error(`PAK rewrite changed retained resource: ${id}`);
  }
  return output;
}

function trimPak(data, expected) {
  const digest = sha256(data);
  if (digest !== expected.inputSha256) throw new Error(`Unknown Electron resources.pak SHA-256: ${digest}. ${regenerateHelp}`);
  const output = rewritePak(data, expected.groups), outputHash = sha256(output);
  if (outputHash !== expected.outputSha256) throw new Error(`PAK output SHA-256 mismatch: expected ${expected.outputSha256}, got ${outputHash}. ${regenerateHelp}`);
  return output;
}

async function trimElectronPak(file, platform, pins = manifest) {
  const expected = pins.platforms[platform];
  if (!expected) throw new Error(`Unsupported Electron ${pins.electronVersion} PAK platform: ${platform}. ${regenerateHelp}`);
  const before = await fs.readFile(file), after = trimPak(before, expected);
  await fs.writeFile(file, after);
  return { removedBytes: before.length - after.length, outputSha256: expected.outputSha256 };
}

function regenerateEntry(data) {
  const { resources } = readPak(data), blocks = [], decoded = new Map();
  for (const [id, value] of [...resources].sort((a, b) => a[0] - b[0])) {
    if (!blocks.length || id !== blocks.at(-1).at(-1) + 1) blocks.push([]);
    blocks.at(-1).push(id);
    let content = value;
    if (value[0] === 0x1f && value[1] === 0x8b) content = gunzipSync(value);
    if (value[0] === 0x1e && value[1] === 0x9b) {
      if (value.length < 8) throw new Error(`Truncated PAK Brotli resource: ${id}`);
      content = brotliDecompressSync(value.subarray(8));
      if (content.length !== value.readUIntLE(2, 6)) throw new Error(`Invalid PAK Brotli size: ${id}`);
    }
    decoded.set(id, content.toString('utf8'));
  }
  // GRIT allocates the DevTools frontend as one contiguous block, including its images and Lighthouse.
  const devtools = blocks.filter(ids => ids.some(id => decoded.get(id).includes('<title>DevTools</title>'))
    && ids.some(id => /"domains"\s*:\s*\[/.test(decoded.get(id)) && /"domain"\s*:\s*"Runtime"/.test(decoded.get(id)))
    && ids.some(id => decoded.get(id).includes('Lighthouse v') && decoded.get(id).includes('https://github.com/GoogleChrome/lighthouse')));
  // These hashes match Chromium's six chrome/browser/resources/intro/sounds files, excluding Blink's HRTF FLAC.
  const sounds = new Set(manifest.introSoundSha256);
  const intro = [...resources].filter(([, value]) => value.subarray(0, 4).toString() === 'fLaC' && sounds.has(sha256(value))).map(([id]) => id).sort((a, b) => a - b);
  const tracingHtml = [...decoded].filter(([, text]) => text.includes('<title>chrome://tracing</title>') && text.includes('src="tracing.js"')).map(([id]) => id);
  const tracingJs = [...decoded].filter(([, text]) => text.includes("tr.exportTo('tr.b'") && text.includes('chrome://tracing')).map(([id]) => id);
  if (intro.length !== 6 || new Set(intro.map(id => sha256(resources.get(id)))).size !== 6 || devtools.length !== 1 || tracingHtml.length !== 1 || tracingJs.length !== 1) {
    throw new Error('Could not uniquely identify all three PAK groups by content; inspect the Chromium resource sources before updating the manifest');
  }
  const groups = { 'intro-sounds': intro, devtools: devtools[0], tracing: [...tracingHtml, ...tracingJs].sort((a, b) => a - b) };
  const output = rewritePak(data, groups);
  return { inputSha256: sha256(data), groups, outputSha256: sha256(output) };
}

module.exports = { readPak, trimPak, trimElectronPak, regenerateEntry };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === '--regenerate' && args.length === 4) {
      const [, electronVersion, platform, file] = args;
      console.log(JSON.stringify({ electronVersion, platforms: { [platform]: regenerateEntry(await fs.readFile(file)) } }, null, 2));
      return;
    }
    if (args.length !== 2) throw new Error('Usage: node scripts/trim-electron-pak.cjs <platform-arch> <resources.pak>\n' + regenerateHelp);
    console.log(JSON.stringify(await trimElectronPak(args[1], args[0])));
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
