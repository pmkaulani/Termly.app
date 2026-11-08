// cropImage.js
// Utility to take an image source and a crop object and return a cropped base64 string or Blob.
// Ensures natural aspect ratios are preserved without squashing or distortion,
// and bounds output dimensions so high-resolution photos don't bloat memory or storage.

export const createImage = (url) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('The selected image could not be decoded.'));
  image.src = url;
});

export function getRadianAngle(degreeValue) {
  return (degreeValue * Math.PI) / 180;
}

/**
 * Crops an image according to pixelCrop coordinates and optional rotation.
 * 
 * @param {string} imageSrc - Object URL or data URL
 * @param {object} pixelCrop - { x, y, width, height } in pixels
 * @param {number} rotation - in degrees (0, 90, 180, 270)
 * @param {object} options - { maxDimension, mimeType, quality, asBlob }
 * @returns {Promise<string|Blob>} Data URL or Blob
 */
export default async function getCroppedImg(
  imageSrc,
  pixelCrop,
  rotation = 0,
  { maxDimension = 512, mimeType = 'image/png', quality = 0.92, asBlob = false } = {}
) {
  if (!imageSrc) throw new Error('No image was supplied for cropping.');
  if (!pixelCrop || !pixelCrop.width || !pixelCrop.height) {
    throw new Error('Select a crop area before applying the crop.');
  }

  const image = await createImage(imageSrc);
  const imageWidth = image.naturalWidth || image.width;
  const imageHeight = image.naturalHeight || image.height;
  const radians = getRadianAngle(rotation);

  const rotatedWidth = Math.ceil(
    Math.abs(Math.cos(radians) * imageWidth) + Math.abs(Math.sin(radians) * imageHeight)
  );
  const rotatedHeight = Math.ceil(
    Math.abs(Math.sin(radians) * imageWidth) + Math.abs(Math.cos(radians) * imageHeight)
  );

  const rotatedCanvas = document.createElement('canvas');
  rotatedCanvas.width = rotatedWidth;
  rotatedCanvas.height = rotatedHeight;
  const rotatedContext = rotatedCanvas.getContext('2d');
  if (!rotatedContext) throw new Error('Your browser could not create an image canvas.');

  rotatedContext.translate(rotatedWidth / 2, rotatedHeight / 2);
  rotatedContext.rotate(radians);
  rotatedContext.drawImage(image, -imageWidth / 2, -imageHeight / 2, imageWidth, imageHeight);

  const sourceX = Math.max(0, Math.floor(pixelCrop.x));
  const sourceY = Math.max(0, Math.floor(pixelCrop.y));
  const sourceWidth = Math.min(Math.ceil(pixelCrop.width), rotatedWidth - sourceX);
  const sourceHeight = Math.min(Math.ceil(pixelCrop.height), rotatedHeight - sourceY);

  if (sourceWidth < 1 || sourceHeight < 1) {
    throw new Error('The selected crop area is outside the image. Please select it again.');
  }

  const safeMax = Math.max(64, Number(maxDimension) || 512);
  const scale = Math.min(1, safeMax / Math.max(sourceWidth, sourceHeight));
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = Math.max(1, Math.round(sourceWidth * scale));
  outputCanvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const outputContext = outputCanvas.getContext('2d');
  if (!outputContext) throw new Error('Your browser could not create the final image.');

  // Retain alpha channel for PNG/WebP (transparency for school logos)
  outputContext.drawImage(
    rotatedCanvas,
    sourceX, sourceY, sourceWidth, sourceHeight,
    0, 0, outputCanvas.width, outputCanvas.height
  );

  if (asBlob) {
    return new Promise((resolve, reject) => {
      outputCanvas.toBlob((blob) => {
        if (!blob) reject(new Error('Canvas conversion to blob failed.'));
        else resolve(blob);
      }, mimeType, quality);
    });
  }

  return outputCanvas.toDataURL(mimeType, quality);
}

/**
 * Helper to obtain both data URL and Blob from a crop operation
 */
export async function getCroppedImgResult(imageSrc, pixelCrop, rotation = 0, options = {}) {
  const dataUrl = await getCroppedImg(imageSrc, pixelCrop, rotation, { ...options, asBlob: false });
  const blob = await getCroppedImg(imageSrc, pixelCrop, rotation, { ...options, asBlob: true });
  return { dataUrl, blob };
}
