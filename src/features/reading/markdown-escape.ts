import { Marked } from 'marked';

// The reading view's own Markdown parser. What looks like HTML in an agent's answer is text: "<title>", "git clone
// <url>", "Promise<void>". Passed through, the page would take <title> or <style> as an element that swallows the rest
// of the answer, and drop unknown tags with the words in them. A parser of its own, so a document's HTML in the file
// preview (a README's <img> or <details>) still renders there. Used by the reading view and by the Markdown worker.
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const readingMarked = new Marked({ async: false, gfm: true, breaks: true, renderer: { html: token => escape(token.text) } });
