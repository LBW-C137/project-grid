const HISTORY_WINDOW = 8 * 1024 * 1024;
const LIVE_READ_LIMIT = 4 * 1024 * 1024;

// Seek by bytes, then discard the cut record before decoding UTF-8 or parsing JSON.
// Metadata/title lookups still read the first record separately.
function transcriptWindow(size) {
  const offset = Math.max(0, size - HISTORY_WINDOW);
  return { offset, skipping: offset > 0 };
}

module.exports = { HISTORY_WINDOW, LIVE_READ_LIMIT, transcriptWindow };
