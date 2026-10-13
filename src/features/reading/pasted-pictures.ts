// Pictures pasted for an SSH project's agent: the picture went to that computer and its path into the message, so the
// message the agent records carries a long remote path. The thumbnail made here when it was pasted stands in for the
// path wherever the message is shown, as a picture pasted locally would be. Kept for this window's lifetime.
const pictures = new Map<string, string>();
const LIMIT = 60;

export function rememberPicture(path: string, thumbnail: string) {
  pictures.delete(path); pictures.set(path, thumbnail);
  while (pictures.size > LIMIT) pictures.delete(pictures.keys().next().value!);
}

// The message's words without the paths of pictures pasted here, and those pictures after any it already had.
export function withPictures(text: string, images: readonly string[] = []): { text: string; images: string[] } {
  const found: string[] = [];
  let words = text;
  for (const [path, thumbnail] of pictures) {
    if (!words.includes(path)) continue;
    found.push(thumbnail); words = words.split(path).join(' ');
  }
  if (!found.length) return { text, images: [...images] };
  return { text: words.replace(/[ \t]{2,}/g, ' ').replace(/^\s+|\s+$/g, ''), images: [...images, ...found].slice(0, 6) };
}
