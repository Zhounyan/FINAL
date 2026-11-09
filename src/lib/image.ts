export const AVATAR_SIZE = 256;
const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'];

/**
 * Turns a picked photo into a small square JPEG data URL (centre-cropped,
 * AVATAR_SIZE px). Large phone photos become ~20–40 KB before upload.
 */
export async function imageFileToAvatar(file: File, size = AVATAR_SIZE): Promise<string> {
  if (!file.type.startsWith('image/') || (file.type && !ACCEPTED.includes(file.type))) {
    throw new Error('Please choose a JPEG, PNG or WebP image.');
  }
  if (file.size > MAX_INPUT_BYTES) throw new Error('That photo is larger than 15 MB. Please choose a smaller one.');

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('This image could not be read. Please choose a JPEG, PNG or WebP photo.'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not process the image.');
    ctx.fillStyle = '#ffffff'; // transparent PNGs get a white background
    ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
