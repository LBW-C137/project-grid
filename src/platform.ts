// macOS uses Command where Windows uses Ctrl for copy, paste and links, and draws its own window buttons over
// the title bar. The root element carries the platform for the styles (data-platform="darwin").
export const isMac = navigator.userAgent.includes('Macintosh');
document.documentElement.dataset.platform = isMac ? 'darwin' : 'win32';
