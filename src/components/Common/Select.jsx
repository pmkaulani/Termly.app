import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon, CheckIcon, SearchIcon, XIcon } from '../CommonIcons';

/**
 * Premium Portalized Select Component
 * Renders into a portal to avoid clipping by parent container overflow.
 * Features intelligent positioning and collision detection.
 */
export default function Select({ 
  value, 
  onChange, 
  options = [], 
  placeholder = "Select...",
  className = "",
  style = {},
  variant = "premium",
  size = "md",
  name,
  searchable = false,
  defaultValue
}) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef(null);
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, placement: 'bottom' });
  const containerRef = useRef(null);
  const menuRef = useRef(null);

  // Determine actual value (controlled vs uncontrolled)
  const actualValue = value !== undefined ? value : internalValue;

  // Find currently selected label
  const selectedOption = options.find(opt => opt.value === actualValue) || options.find(opt => opt.id === actualValue);
  const displayLabel = selectedOption ? (selectedOption.label || selectedOption.name || selectedOption.year + ' — ' + selectedOption.term) : placeholder;

  // Positioning Logic
  const updateCoords = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const windowHeight = window.innerHeight;
      const menuHeight = 280; // Estimated max height
      
      let placement = 'bottom';
      let top = rect.bottom + window.scrollY + 8;
      
      // Collision detection: if not enough space below, flip to top
      if (rect.bottom + menuHeight > windowHeight && rect.top > menuHeight) {
        placement = 'top';
        top = rect.top + window.scrollY - menuHeight - 8;
      }

      setCoords({
        top,
        left: rect.left + window.scrollX,
        width: rect.width,
        placement
      });
    }
  };

  useLayoutEffect(() => {
    if (isOpen) {
      updateCoords();
      window.addEventListener('scroll', updateCoords, true);
      window.addEventListener('resize', updateCoords);
      
      // Auto-focus search input if searchable
      if (searchable) {
        setTimeout(() => {
          searchInputRef.current?.focus();
        }, 50);
      }
    } else {
      setSearchTerm(''); // Reset search when closed
    }
    return () => {
      window.removeEventListener('scroll', updateCoords, true);
      window.removeEventListener('resize', updateCoords);
    };
  }, [isOpen]);

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        // Also check if the click was inside the portal menu
        if (menuRef.current && !menuRef.current.contains(event.target)) {
          setIsOpen(false);
        }
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleSelect = (option) => {
    const newVal = option.value !== undefined ? option.value : option.id;
    if (onChange) {
      onChange({ target: { name, value: newVal } });
    }
    setInternalValue(newVal);
    setIsOpen(false);
  };

  const Menu = (
    <div 
      ref={menuRef}
      className={`custom-select-menu animate-pop ${coords.placement}`}
      style={{
        position: 'absolute',
        top: coords.top,
        left: coords.left,
        width: coords.width ? Math.max(coords.width, 170) : 'auto',
        minWidth: '170px',
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1.5px solid rgba(14, 165, 233, 0.15)',
        borderRadius: '14px',
        boxShadow: '0 20px 40px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05)',
        zIndex: 99999,
        maxHeight: '340px',
        overflowY: 'auto',
        padding: '6px',
        pointerEvents: 'auto'
      }}
    >
      {searchable && (
        <div style={{ 
          padding: '8px', 
          position: 'sticky', 
          top: -6, 
          background: 'rgba(255, 255, 255, 0.9)', 
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid var(--border)',
          marginBottom: '6px',
          zIndex: 1
        }}>
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-light)' }}>
              <SearchIcon size={14} />
            </div>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 32px',
                border: '1.5px solid var(--border)',
                borderRadius: '8px',
                fontSize: '0.875rem',
                outline: 'none',
                background: '#fff'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setIsOpen(false);
              }}
            />
            {searchTerm && (
              <button 
                onClick={() => setSearchTerm('')}
                style={{ 
                  position: 'absolute', 
                  right: '10px', 
                  top: '50%', 
                  transform: 'translateY(-50%)', 
                  border: 'none', 
                  background: 'none', 
                  cursor: 'pointer',
                  color: 'var(--text-light)',
                  padding: 4
                }}
              >
                <XIcon size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      {(() => {
        const filteredOptions = searchable 
          ? options.filter(opt => {
              const label = (opt.label || opt.name || '').toLowerCase();
              const val = (opt.value || opt.id || '').toLowerCase();
              return label.includes(searchTerm.toLowerCase()) || val.includes(searchTerm.toLowerCase());
            })
          : options;

        if (filteredOptions.length === 0) {
          return (
            <div style={{ padding: '16px', fontSize: '0.8rem', color: 'var(--text-light)', textAlign: 'center' }}>
              {searchTerm ? 'No matches found' : 'No options available'}
            </div>
          );
        }

        return filteredOptions.map((opt, idx) => {
          const optVal = opt.value !== undefined ? opt.value : opt.id;
          const isSelected = actualValue !== undefined && actualValue !== null && optVal === actualValue;
          return (
            <div
              key={opt.value || opt.id || idx}
              className={`custom-select-option ${isSelected ? 'selected' : ''}`}
              onClick={() => handleSelect(opt)}
              style={{
                padding: size === 'sm' ? '7px 10px' : '12px 14px',
                borderRadius: size === 'sm' ? '6px' : '10px',
                cursor: 'pointer',
                fontSize: size === 'sm' ? '0.82rem' : '0.9rem',
                fontWeight: isSelected ? 700 : 500,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                color: isSelected ? 'var(--primary)' : 'var(--text-main)',
                background: isSelected ? 'var(--primary-50)' : 'transparent',
                marginBottom: '2px',
                transition: 'all 0.15s cubic-bezier(0.4, 0, 0.2, 1)'
              }}
              onMouseEnter={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'var(--bg)';
              }}
              onMouseLeave={(e) => {
                if (!isSelected) e.currentTarget.style.background = 'transparent';
              }}
            >
              <span style={{ 
                whiteSpace: 'nowrap', 
                overflow: 'hidden', 
                textOverflow: 'ellipsis' 
              }}>
                {opt.label || opt.name || (opt.year && opt.term ? `${opt.year} — ${opt.term}` : '') || 'Option'}
              </span>
              {isSelected && <CheckIcon size={14} color="var(--primary)" />}
            </div>
          );
        });
      })()}
    </div>
  );

  return (
    <div 
      className={`custom-select-container ${className}`} 
      ref={containerRef}
      style={{ position: 'relative', width: 'auto', display: 'inline-block', ...style }}
    >
      {name && <input type="hidden" name={name} value={actualValue || ''} />}
      
      {/* Trigger Button */}
      <div 
        className={`custom-select-trigger ${isOpen ? 'open' : ''} ${variant}`}
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: size === 'sm' ? '6px 12px' : '10px 18px',
          minWidth: 'inherit',
          background: 'var(--bg-card)',
          border: '1.5px solid var(--border)',
          borderRadius: size === 'sm' ? '6px' : 'var(--radius-sm)',
          cursor: 'pointer',
          fontSize: size === 'sm' ? '0.8rem' : '0.875rem',
          fontWeight: 600,
          color: 'var(--text-main)',
          transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          boxShadow: isOpen ? '0 0 0 4px var(--primary-50)' : 'var(--shadow-sm)',
          borderColor: isOpen ? 'var(--primary)' : 'var(--border)'
        }}
      >
        <span style={{ 
          whiteSpace: 'nowrap', 
          overflow: 'hidden', 
          textOverflow: 'ellipsis',
          marginRight: 10
        }}>
          {displayLabel}
        </span>
        <div style={{ 
          transform: `rotate(${isOpen ? '180deg' : '0deg'})`,
          transition: 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          display: 'flex',
          alignItems: 'center',
          color: isOpen ? 'var(--primary)' : 'var(--text-light)'
        }}>
          <ChevronDownIcon size={14} />
        </div>
      </div>

      {/* Portalized Menu */}
      {isOpen && createPortal(Menu, document.body)}
    </div>
  );
}
