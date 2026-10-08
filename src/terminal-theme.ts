import type { ITheme } from '@xterm/xterm';

// Keep the established dark palette identical for Forest, Mountain Blue and Wild Red.
export const darkTerminalTheme: ITheme = {
  background: '#00000000', foreground: '#ffffff', cursor: '#ffffff',
  selectionBackground: '#405770', black: '#252a34', red: '#ff969e',
  green: '#a2ddb8', yellow: '#f2d596', blue: '#a1caff', magenta: '#d0b6f7',
  cyan: '#a0e0e8', white: '#e7eff9', brightBlack: '#b2c2d5', brightRed: '#ffacb2',
  brightGreen: '#a1d8b7', brightYellow: '#f0d297', brightBlue: '#a0caff',
  brightMagenta: '#d0baf2', brightCyan: '#a2e1e7', brightWhite: '#f2f5fa',
  scrollbarSliderBackground: '#46536455', scrollbarSliderHoverBackground: '#64768c88', scrollbarSliderActiveBackground: '#7b8ea599',
};

export const lightTerminalTheme: ITheme = {
  // Transparent white supplies light RGB channels to xterm's contrast calculation,
  // while the CSS inner screen supplies the actual frosted background.
  background: '#ffffff00', foreground: '#0e1e33', cursor: '#163e75', cursorAccent: '#ffffff',
  selectionBackground: '#c9def5', selectionInactiveBackground: '#dce8f5',
  black: '#0e1e33', red: '#c0262d', green: '#0f7b4f', yellow: '#9a6700',
  blue: '#1b5fbf', magenta: '#8a3fc0', cyan: '#0b7285', white: '#56677d',
  brightBlack: '#56677d', brightRed: '#c3323b', brightGreen: '#168256', brightYellow: '#956c0e',
  brightBlue: '#286bc5', brightMagenta: '#9250be', brightCyan: '#13798b', brightWhite: '#4c6078',
  scrollbarSliderBackground: '#17385844', scrollbarSliderHoverBackground: '#17385866', scrollbarSliderActiveBackground: '#17385888',
};

export function terminalTheme(theme: string | undefined): ITheme {
  return { ...(theme === 'daylight' ? lightTerminalTheme : darkTerminalTheme) };
}

export function terminalDecorationColors(theme: string | undefined) {
  return theme === 'daylight'
    ? { bullet: '#b02663', heading: '#90316e' }
    : { bullet: '#ff6b9a', heading: '#ff9fd5' };
}
