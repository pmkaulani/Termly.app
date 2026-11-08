import React, { useState, useRef, useEffect } from 'react';
import ImageCropperModal from './ImageCropperModal';
import { UploadIcon, DeleteIcon, RefreshIcon, UserIcon, SchoolIcon } from '../CommonIcons';

/**
 * Reusable image upload and crop field.
 * Handles validation, cropping, previewing, and removal for school logos,
 * student portraits, and teacher portraits.
 */
export default function ImageUploadField({
  value = '',
  onChange,
  mode = 'portrait', // 'logo' | 'portrait'
  label = null,
  shape = null, // 'circle' | 'rounded' | 'rectangle'
  size = 96,
  placeholderInitials = '',
  placeholderIcon = null,
  helperText = null,
  maxSizeBytes = null,
  disabled = false
}) {
  const fileInputRef = useRef(null);
  const [cropImageSrc, setCropImageSrc] = useState(null);
  const [isCropping, setIsCropping] = useState(false);
  const [error, setError] = useState(null);
  const [imageFailed, setImageFailed] = useState(false);

  // Default limits and shapes
  const effectiveShape = shape || (mode === 'logo' ? 'rectangle' : 'circle');
  const defaultMaxSize = mode === 'logo' ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
  const effectiveMaxSize = maxSizeBytes || defaultMaxSize;
  const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];

  // Reset imageFailed state if value changes
  useEffect(() => {
    setImageFailed(false);
  }, [value]);

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);

    // 1. Validate file extension
    const ext = file.name?.split('.').pop()?.toLowerCase();
    const validExtensions = ['png', 'jpg', 'jpeg', 'webp'];
    if (!validExtensions.includes(ext)) {
      setError('Please upload a PNG, JPG, or WebP image file.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // 2. Validate MIME type
    if (!allowedMimeTypes.includes(file.type)) {
      setError(`Unsupported image type (${file.type}). Only PNG, JPG and WebP are allowed.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // 3. Validate file size
    if (file.size > effectiveMaxSize) {
      const maxMb = Math.round(effectiveMaxSize / (1024 * 1024));
      setError(`Image file is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Maximum allowed is ${maxMb} MB.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    // 4. Validate image decodability
    const reader = new FileReader();
    reader.onload = (event) => {
      const source = event.target?.result;
      const probe = new Image();
      probe.onload = () => {
        setCropImageSrc(source);
        setIsCropping(true);
        if (fileInputRef.current) fileInputRef.current.value = '';
      };
      probe.onerror = () => {
        setError('The selected image is corrupt or cannot be opened by your browser.');
        if (fileInputRef.current) fileInputRef.current.value = '';
      };
      probe.src = source;
    };
    reader.onerror = () => {
      setError('Could not read the selected file.');
      if (fileInputRef.current) fileInputRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  const handleCropSave = ({ dataUrl, blob }) => {
    setImageFailed(false);
    if (onChange) {
      onChange({ dataUrl, blob, remove: false });
    }
  };

  const handleRemove = () => {
    setImageFailed(false);
    if (onChange) {
      onChange({ dataUrl: '', blob: null, remove: true });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const hasImage = Boolean(value) && !imageFailed;

  // Frame styling based on shape
  const borderRadius = effectiveShape === 'circle' ? '50%' : effectiveShape === 'rounded' ? '12px' : '8px';
  const frameWidth = mode === 'logo' ? 'min(100%, 240px)' : `${size}px`;
  const frameHeight = mode === 'logo' ? '100px' : `${size}px`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      {label && (
        <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-main, #0f172a)' }}>
          {label}
        </label>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
        {/* Visual Frame */}
        <div
          style={{
            width: frameWidth,
            height: frameHeight,
            borderRadius,
            backgroundColor: 'var(--bg, #f1f5f9)',
            border: '2px dashed var(--border, #cbd5e1)',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
            flexShrink: 0
          }}
        >
          {hasImage ? (
            <img
              src={value}
              alt={label || 'Photo preview'}
              onError={() => setImageFailed(true)}
              style={{
                width: '100%',
                height: '100%',
                objectFit: mode === 'logo' ? 'contain' : 'cover',
                display: 'block'
              }}
            />
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted, #94a3b8)',
                textAlign: 'center',
                padding: '8px'
              }}
            >
              {placeholderInitials ? (
                <span style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--primary, #0284c7)' }}>
                  {placeholderInitials}
                </span>
              ) : placeholderIcon ? (
                placeholderIcon
              ) : mode === 'logo' ? (
                <SchoolIcon size={28} />
              ) : (
                <UserIcon size={28} />
              )}
            </div>
          )}
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem' }}
            >
              <UploadIcon size={14} /> {hasImage ? 'Change Photo' : 'Upload Photo'}
            </button>

            {hasImage && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={handleRemove}
                disabled={disabled}
                style={{ color: '#ef4444', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem' }}
              >
                <DeleteIcon size={14} /> Remove
              </button>
            )}
          </div>

          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted, #64748b)' }}>
            {helperText || (mode === 'logo' ? 'PNG, JPG or WebP (max 2 MB). Preserves wordmark width.' : 'PNG, JPG or WebP (max 5 MB). 1:1 portrait.')}
          </span>
        </div>
      </div>

      {/* Hidden File Input */}
      <input
        ref={fileInputRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileSelect}
        disabled={disabled}
      />

      {/* Error Alert */}
      {error && (
        <div style={{ fontSize: '0.8rem', color: '#b91c1c', marginTop: '4px' }}>
          {error}
        </div>
      )}

      {/* Cropper Modal */}
      <ImageCropperModal
        isOpen={isCropping}
        imageSrc={cropImageSrc}
        mode={mode}
        onClose={() => {
          setIsCropping(false);
          setCropImageSrc(null);
        }}
        onCropSave={handleCropSave}
      />
    </div>
  );
}
