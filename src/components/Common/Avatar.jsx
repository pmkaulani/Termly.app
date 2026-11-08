import React, { useState, useEffect } from 'react';
import { getPersonPhotoSignedUrl } from '../../lib/storageHelpers';

const PALETTE = ['#0284c7', '#7c3aed', '#059669', '#d97706', '#dc2626', '#4f46e5', '#0891b2'];

export default function Avatar({
  photoPath = null,
  photoUrl = null,
  name = '',
  size = 32,
  shape = 'circle', // 'circle' | 'rounded'
  className = '',
  style = {}
}) {
  const [resolvedUrl, setResolvedUrl] = useState(photoUrl || null);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
    if (photoUrl) {
      setResolvedUrl(photoUrl);
      return;
    }
    if (photoPath) {
      let active = true;
      getPersonPhotoSignedUrl(photoPath).then((url) => {
        if (active) setResolvedUrl(url);
      });
      return () => { active = false; };
    }
    setResolvedUrl(null);
  }, [photoPath, photoUrl]);

  const initials = (name || '')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase() || '?';

  const charCode = (name || '?').charCodeAt(0) || 0;
  const bgColor = PALETTE[charCode % PALETTE.length];
  const borderRadius = shape === 'circle' ? '50%' : '8px';

  if (resolvedUrl && !hasError) {
    return (
      <img
        src={resolvedUrl}
        alt={name ? `${name} portrait` : 'Portrait'}
        onError={() => setHasError(true)}
        className={className}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          borderRadius,
          objectFit: 'cover',
          display: 'inline-block',
          flexShrink: 0,
          ...style
        }}
      />
    );
  }

  return (
    <div
      className={className}
      aria-label={name}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius,
        backgroundColor: bgColor,
        color: '#ffffff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: `${Math.max(10, Math.round(size * 0.4))}px`,
        fontWeight: 700,
        userSelect: 'none',
        flexShrink: 0,
        ...style
      }}
    >
      {initials}
    </div>
  );
}
