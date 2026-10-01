// Interface text is written in Chinese in the source. English mode looks each phrase up in
// locales/en.json (Chinese phrase -> English); a missing entry falls back to the Chinese text.
// Entries may hold {name} placeholders: t('正在删除：{name}', { name }) fills them after the lookup, and a
// finished message such as '正在删除：a.txt' (an error or progress text built elsewhere) is matched against
// those templates too, so it reads in English without every module knowing the language.
const en = require('./locales/en.json');

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
const patterns = Object.keys(en).filter(key => /\{\w+\}/.test(key)).map(key => {
  const names = [];
  const source = key.split(/(\{\w+\})/).map(part => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (!name) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(name); return '([\\s\\S]*?)';
  }).join('');
  return { regex: new RegExp(`^${source}$`), names, template: en[key] };
});

function translate(language, text, values) {
  if (language !== 'en' || typeof text !== 'string') return values ? fill(String(text), values) : text;
  if (Object.prototype.hasOwnProperty.call(en, text)) return values ? fill(en[text], values) : en[text];
  if (!values) {
    for (const { regex, names, template } of patterns) {
      const match = regex.exec(text);
      if (match) return fill(template, Object.fromEntries(names.map((name, index) => [name, translate(language, match[index + 1])])));
    }
  }
  return values ? fill(text, values) : text;
}

module.exports = { translate, en };
