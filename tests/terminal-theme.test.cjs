const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalTheme, darkTerminalTheme, lightTerminalTheme, terminalDecorationColors } = require('../src/terminal-theme.ts');

function contrastOnWhite(hex) {
  const channels = hex.slice(1, 7).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return 1.05 / (.2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2] + .05);
}

test('Daylight selects light ink and a transparent white contrast base; other themes retain the dark palette', () => {
  assert.deepEqual(terminalTheme('daylight'), lightTerminalTheme);
  assert.equal(lightTerminalTheme.background, '#ffffff00');
  assert.equal(lightTerminalTheme.foreground, '#0e1e33');
  for (const theme of ['forest', 'mountain-blue', 'wild-red', undefined]) {
    assert.deepEqual(terminalTheme(theme), darkTerminalTheme);
    assert.deepEqual(terminalDecorationColors(theme), { bullet: '#ff6b9a', heading: '#ff9fd5' });
  }
  // xterm may normalize options; callers must not share a mutable palette.
  const first = terminalTheme('daylight'); first.foreground = '#ffffff';
  assert.equal(terminalTheme('daylight').foreground, '#0e1e33');
});

test('every light ANSI color, default foreground, cursor and decoration meets 4.5:1 on white', () => {
  const keys = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite', 'foreground', 'cursor'];
  for (const key of keys) assert.ok(contrastOnWhite(lightTerminalTheme[key]) >= 4.5, `${key}: ${contrastOnWhite(lightTerminalTheme[key]).toFixed(2)}:1`);
  for (const [key, color] of Object.entries(terminalDecorationColors('daylight'))) assert.ok(contrastOnWhite(color) >= 4.5, key);
});
