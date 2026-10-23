// A picked image becomes the user's avatar here, in the window: the centred square, 256 px, as WebP. Nothing is uploaded.
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const AVATAR_SIZE = 256;

export async function avatarFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_SIZE;
    canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return canvas.toDataURL('image/webp', 0.85);
  } finally { bitmap.close(); }
}
