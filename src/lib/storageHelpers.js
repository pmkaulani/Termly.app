import { supabase } from './supabase';

// Cache for short-lived signed URLs: Map<photoPath, { url: string, expiresAt: number }>
const signedUrlCache = new Map();

/**
 * Converts a data URL or Blob to a standard Blob
 */
async function toBlob(fileOrBlobOrDataUrl, defaultMime = 'image/png') {
  if (fileOrBlobOrDataUrl instanceof Blob) {
    return fileOrBlobOrDataUrl;
  }
  if (typeof fileOrBlobOrDataUrl === 'string' && fileOrBlobOrDataUrl.startsWith('data:')) {
    const res = await fetch(fileOrBlobOrDataUrl);
    return await res.blob();
  }
  throw new Error('Unsupported image data format for upload.');
}

/**
 * Uploads a school logo to the public 'school-logos' bucket.
 * Returns the public URL.
 */
export async function uploadSchoolLogo({ schoolId, fileOrBlob, oldLogoUrl = null }) {
  if (!schoolId) throw new Error('School context is required for logo upload.');

  const blob = await toBlob(fileOrBlob, 'image/png');
  const filename = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}.png`;
  const storagePath = `${schoolId}/logo/${filename}`;

  try {
    const { error: uploadError } = await supabase.storage
      .from('school-logos')
      .upload(storagePath, blob, {
        contentType: blob.type || 'image/png',
        upsert: true
      });

    if (uploadError) {
      console.warn('Storage upload error for school logo:', uploadError);
      // Fallback: If Storage bucket is unavailable or failing, return data URL if available
      if (typeof fileOrBlob === 'string' && fileOrBlob.startsWith('data:')) {
        return { logoUrl: fileOrBlob, storagePath: null };
      }
      throw uploadError;
    }

    const { data: urlData } = supabase.storage
      .from('school-logos')
      .getPublicUrl(storagePath);

    const publicUrl = urlData?.publicUrl || '';

    // Clean up old logo asset if it was stored in the same bucket
    if (oldLogoUrl && oldLogoUrl.includes('/school-logos/') && oldLogoUrl.includes(schoolId)) {
      try {
        const parts = oldLogoUrl.split('/school-logos/');
        if (parts[1]) {
          const oldPath = decodeURIComponent(parts[1].split('?')[0]);
          await supabase.storage.from('school-logos').remove([oldPath]);
        }
      } catch (cleanupErr) {
        console.warn('Could not clean up old school logo asset:', cleanupErr);
      }
    }

    return { logoUrl: publicUrl, storagePath };
  } catch (err) {
    console.error('Failed to upload school logo:', err);
    throw err;
  }
}

/**
 * Uploads a student or teacher portrait to the private 'school-people-photos' bucket.
 * Returns the private photo_path.
 */
export async function uploadPersonPhoto({
  schoolId,
  entityType, // 'students' | 'teachers'
  entityId,
  fileOrBlob,
  oldPhotoPath = null
}) {
  if (!schoolId || !entityType || !entityId) {
    throw new Error('School ID, entity type, and entity ID are required for portrait upload.');
  }

  const blob = await toBlob(fileOrBlob, 'image/webp');
  const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/png' ? 'png' : 'webp';
  const filename = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${ext}`;
  const storagePath = `${schoolId}/${entityType}/${entityId}/${filename}`;

  const { error: uploadError } = await supabase.storage
    .from('school-people-photos')
    .upload(storagePath, blob, {
      contentType: blob.type || 'image/webp',
      upsert: true
    });

  if (uploadError) {
    console.error('Storage upload error for portrait:', uploadError);
    throw uploadError;
  }

  // Invalidate cache for old path and clean up old storage asset
  if (oldPhotoPath && oldPhotoPath !== storagePath) {
    signedUrlCache.delete(oldPhotoPath);
    try {
      await supabase.storage.from('school-people-photos').remove([oldPhotoPath]);
    } catch (cleanupErr) {
      console.warn('Could not clean up old portrait asset:', cleanupErr);
    }
  }

  return { photoPath: storagePath };
}

/**
 * Resolves a short-lived signed URL for a private portrait in 'school-people-photos'.
 * Results are cached in-memory with expiration buffer.
 */
export async function getPersonPhotoSignedUrl(photoPath, expiresIn = 3600) {
  if (!photoPath) return null;

  // Direct HTTP or Data URL compatibility
  if (photoPath.startsWith('http://') || photoPath.startsWith('https://') || photoPath.startsWith('data:')) {
    return photoPath;
  }

  const now = Date.now();
  const cached = signedUrlCache.get(photoPath);
  if (cached && now < cached.expiresAt - 60000) {
    return cached.url;
  }

  try {
    const { data, error } = await supabase.storage
      .from('school-people-photos')
      .createSignedUrl(photoPath, expiresIn);

    if (error || !data?.signedUrl) {
      console.warn(`Could not resolve signed URL for photo: ${photoPath}`, error);
      return null;
    }

    signedUrlCache.set(photoPath, {
      url: data.signedUrl,
      expiresAt: now + expiresIn * 1000
    });

    return data.signedUrl;
  } catch (err) {
    console.warn(`Failed to resolve signed URL for photo: ${photoPath}`, err);
    return null;
  }
}

/**
 * Deletes a person's photo from the private storage bucket.
 */
export async function deletePersonPhoto(photoPath) {
  if (!photoPath || photoPath.startsWith('http') || photoPath.startsWith('data:')) {
    return;
  }
  signedUrlCache.delete(photoPath);
  try {
    await supabase.storage.from('school-people-photos').remove([photoPath]);
  } catch (err) {
    console.warn('Failed to delete photo from storage:', err);
  }
}
