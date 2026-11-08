import React, { useState, useEffect, useRef } from 'react';
import Cropper from 'react-easy-crop';
import { getCroppedImgResult } from '../../utils/cropImage';
import { SaveIcon, RefreshIcon, XIcon } from '../CommonIcons';

/**
 * Reusable modal for cropping school logos and student/teacher portraits.
 * Supports:
 *  - 'logo' mode: preserves natural aspect ratio (wide wordmarks, tall crests), PNG output for transparency
 *  - 'portrait' mode: locked 1:1 aspect ratio, pan/zoom to frame face, 90-deg rotation, 512x512 output
 */
export default function ImageCropperModal({
  isOpen,
  imageSrc,
  onClose,
  onCropSave,
  mode = 'portrait',
  title = null
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);
  const [aspect, setAspect] = useState(mode === 'logo' ? 1 : 1);
  const [naturalDimensions, setNaturalDimensions] = useState({ width: 0, height: 0 });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState(null);

  // Probe natural image aspect ratio
  useEffect(() => {
    if (!imageSrc) return;
    let isMounted = true;
    const probe = new Image();
    probe.onload = () => {
      if (!isMounted) return;
      const w = probe.naturalWidth || probe.width;
      const h = probe.naturalHeight || probe.height;
      setNaturalDimensions({ width: w, height: h });
      if (mode === 'logo') {
        const ratio = w / h;
        setAspect(Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
      } else {
        setAspect(1);
      }
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setRotation(0);
      setCroppedAreaPixels(null);
      setError(null);
    };
    probe.onerror = () => {
      if (isMounted) setError('Could not read the selected image.');
    };
    probe.src = imageSrc;

    return () => {
      isMounted = false;
    };
  }, [imageSrc, mode]);

  if (!isOpen || !imageSrc) return null;

  const handleCropComplete = (croppedArea, pixels) => {
    setCroppedAreaPixels(pixels);
  };

  const handleReset = () => {
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setRotation(0);
    if (mode === 'logo' && naturalDimensions.width && naturalDimensions.height) {
      setAspect(naturalDimensions.width / naturalDimensions.height);
    }
  };

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  const handleSave = async () => {
    if (!croppedAreaPixels) {
      setError('Adjust the crop area before applying.');
      return;
    }
    setIsSaving(true);
    setError(null);

    try {
      const mimeType = mode === 'logo' ? 'image/png' : 'image/webp';
      const result = await getCroppedImgResult(imageSrc, croppedAreaPixels, rotation, {
        maxDimension: 512,
        mimeType,
        quality: 0.92
      });
      await onCropSave(result);
      onClose();
    } catch (err) {
      console.error('Failed to crop image:', err);
      setError(err.message || 'Failed to crop image.');
    } finally {
      setIsSaving(false);
    }
  };

  const modalTitle = title || (mode === 'logo' ? 'Crop School Logo' : 'Crop Portrait Photo');
  const cropInstructions = mode === 'logo'
    ? 'Adjust the crop box to frame your school logo. The full logo aspect ratio is preserved.'
    : 'Pan and zoom to frame the face comfortably inside the circle/square avatar frame.';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cropper-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.88)',
        zIndex: 99999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px'
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '540px',
          background: 'var(--bg-card, #ffffff)',
          color: 'var(--text-main, #0f172a)',
          borderRadius: '16px',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border, #e2e8f0)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div>
            <h3 id="cropper-modal-title" style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700 }}>
              {modalTitle}
            </h3>
            <p style={{ margin: '3px 0 0', fontSize: '0.8rem', color: 'var(--text-muted, #64748b)' }}>
              {cropInstructions}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-muted, #64748b)',
              padding: '6px'
            }}
          >
            <XIcon size={20} />
          </button>
        </div>

        {/* Cropper Viewport */}
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '320px',
            background: '#0f172a'
          }}
        >
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={aspect}
            cropShape={mode === 'portrait' ? 'round' : 'rect'}
            showGrid={true}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={handleCropComplete}
          />
        </div>

        {/* Controls */}
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {error && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                backgroundColor: '#fee2e2',
                color: '#b91c1c',
                fontSize: '0.85rem'
              }}
            >
              {error}
            </div>
          )}

          {/* Zoom Slider & Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '180px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                <label style={{ fontSize: '0.8rem', fontWeight: 600 }}>Zoom</label>
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted, #64748b)' }}>
                  {Math.round(zoom * 100)}%
                </span>
              </div>
              <input
                type="range"
                value={zoom}
                min={1}
                max={3}
                step={0.05}
                aria-label="Zoom adjustment"
                onChange={(e) => setZoom(Number(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--primary, #0284c7)' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleRotate}
                title="Rotate 90° Clockwise"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', padding: '6px 12px' }}
              >
                ↻ Rotate
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleReset}
                title="Fit entire image / Reset"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', padding: '6px 12px' }}
              >
                <RefreshIcon size={14} /> {mode === 'logo' ? 'Fit Logo' : 'Reset'}
              </button>
            </div>
          </div>

          {/* Footer Buttons */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '12px',
              paddingTop: '8px',
              borderTop: '1px solid var(--border, #e2e8f0)'
            }}
          >
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={isSaving}
              style={{ minWidth: '90px' }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={isSaving}
              style={{ minWidth: '130px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
            >
              {isSaving ? 'Saving...' : <><SaveIcon size={16} /> Apply Crop</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
