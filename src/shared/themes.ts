export const themes = [
  { id: 'daylight', name: '晴空', description: 'Glacier National Park · 蓝天、雪山与林海' },
  { id: 'forest', name: '林间光影', description: 'High Sierra · 山湖与秋日林光' },
  { id: 'mountain-blue', name: '山青蓝', description: 'Big Sur · 青山与蔚蓝海岸' },
  { id: 'wild-red', name: '西野红', description: 'Sierra · 暮色云霞与暖红山峰' },
  { id: 'yosemite', name: '半穹霞光', description: 'Yosemite · 粉色晚霞里的半穹顶' },
  { id: 'el-capitan', name: '酋长岩', description: 'El Capitan · 夕照岩壁与雪峰' },
  { id: 'mojave', name: '沙丘暮色', description: 'Mojave · 暮光下的沙丘' },
  { id: 'catalina', name: '海岛暮蓝', description: 'Catalina · 黄昏海面上的海岛' },
  { id: 'mono-amber', name: '黑白橙', description: '雾白玻璃 · 清晰文字与橙色提醒' },
  { id: 'mono-amber-dark', name: '白黑橙', description: '深色玻璃 · 清晰白字与橙色提醒' },
] as const;

export type ThemeId = typeof themes[number]['id'];

export function applyTheme(value: string) {
  const theme = themes.some(item => item.id === value) ? value : 'daylight';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('agentrix-theme', theme); } catch {}
}

export function restoreTheme() {
  try { applyTheme(localStorage.getItem('agentrix-theme') || 'daylight'); }
  catch { applyTheme('daylight'); }
}
