// A short spoken name for what a round worked on, taken from the prompt that started it:
// the first sentence, without code, links or paths, cut to a phrase that is quick to hear.
// Bare follow-ups ("继续", "continue", "ok") say nothing about the work, so they give no summary.
const FOLLOW_UP = /^(继续|接着|继续吧|继续执行|好的?|可以|行|嗯|是的?|对|go on|continue|keep going|ok(ay)?|yes|y|proceed)[。.!！\s]*$/i;

function summarizeTask(prompt, { maxChars = 28, maxWords = 12 } = {}) {
  if (typeof prompt !== 'string') return '';
  let text = prompt
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\\/\s]+[\\/])+[^\\/\s]*/g, ' ')
    .replace(/^\s*(?:[-*>#]+|\d+[.)、])\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  text = (text.split(/(?<=[。！？!?；;])|\.(?=\s|$)|\n/)[0] || '').replace(/[，,：:、\s。！？!?；;.]+$/u, '').trim();
  if (!text || FOLLOW_UP.test(text)) return '';
  if (/[一-鿿]/.test(text)) return [...text].length > maxChars ? [...text].slice(0, maxChars).join('').replace(/[，,：:、\s]+$/u, '') + '…' : text;
  const words = text.split(' ');
  return words.length > maxWords ? words.slice(0, maxWords).join(' ').replace(/[,;:]+$/, '') + '…' : text;
}

module.exports = { summarizeTask };
