/**
 * Toast — Lightweight, centralized notification system for Termly.
 * 
 * Usage:
 *   import { toast } from '../utils/toast';
 *   toast.success('Student saved!');
 *   toast.error('Failed to save marks.');
 *   toast.info('Syncing data...');
 */

let _container = null;

function getContainer() {
  if (_container && document.body.contains(_container)) return _container;
  
  _container = document.createElement('div');
  _container.id = 'Termly-toast-container';
  Object.assign(_container.style, {
    position: 'fixed',
    top: '20px',
    right: '20px',
    zIndex: '99999',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    pointerEvents: 'none',
    maxWidth: '400px',
  });
  document.body.appendChild(_container);
  return _container;
}

function createToast(message, type = 'info', duration = 4000) {
  const container = getContainer();

  const colors = {
    success: { bg: '#059669', icon: '✓' },
    error:   { bg: '#DC2626', icon: '✕' },
    info:    { bg: '#2563EB', icon: 'ℹ' },
    warning: { bg: '#D97706', icon: '⚠' },
  };

  const config = colors[type] || colors.info;

  const el = document.createElement('div');
  Object.assign(el.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '14px 20px',
    borderRadius: '14px',
    background: config.bg,
    color: '#fff',
    fontFamily: '"Inter", sans-serif',
    fontSize: '0.9rem',
    fontWeight: '600',
    boxShadow: '0 10px 30px -5px rgba(0,0,0,0.3)',
    pointerEvents: 'auto',
    cursor: 'pointer',
    animation: 'toastSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
    opacity: '1',
    transition: 'opacity 0.3s, transform 0.3s',
  });

    const iconSpan = document.createElement('span');
    iconSpan.style.cssText = "font-size: 1.2rem;";
    iconSpan.textContent = config.icon;

    const textSpan = document.createElement('span');
    textSpan.style.cssText = "font-weight: 500; font-size: 0.95rem;";
    textSpan.textContent = message;

    el.appendChild(iconSpan);
    el.appendChild(textSpan);

  el.onclick = () => dismissToast(el);
  container.appendChild(el);

  // Inject animation keyframes once
  if (!document.getElementById('toast-keyframes')) {
    const style = document.createElement('style');
    style.id = 'toast-keyframes';
    style.textContent = `
      @keyframes toastSlideIn {
        from { opacity: 0; transform: translateX(100px); }
        to { opacity: 1; transform: translateX(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // Auto-dismiss
  if (duration > 0) {
    setTimeout(() => dismissToast(el), duration);
  }

  return el;
}

function dismissToast(el) {
  el.style.opacity = '0';
  el.style.transform = 'translateX(100px)';
  setTimeout(() => el.remove(), 300);
}

export const toast = {
  success: (msg, duration) => createToast(msg, 'success', duration),
  error:   (msg, duration) => createToast(msg, 'error', duration || 6000),
  info:    (msg, duration) => createToast(msg, 'info', duration),
  warning: (msg, duration) => createToast(msg, 'warning', duration || 5000),
};

/**
 * Global error handler — wraps any async action with toast feedback.
 * 
 * Usage:
 *   import { handleError } from '../utils/toast';
 *   const result = await handleError(() => saveStudent(data), 'Student saved!');
 */
export async function handleError(asyncFn, successMessage = null) {
  try {
    const result = await asyncFn();
    if (successMessage) toast.success(successMessage);
    return result;
  } catch (err) {
    console.error('[handleError]', err);

    // Parse Supabase-specific errors
    let userMessage = err.message || 'An unexpected error occurred.';
    
    if (err.code === '23505') {
      userMessage = 'This record already exists (duplicate entry).';
    } else if (err.code === '23503') {
      userMessage = 'Cannot delete: this record is referenced by other data.';
    } else if (err.code === '42501') {
      userMessage = 'Permission denied. You may not have access to this action.';
    } else if (err.message?.includes('Mark entry is closed')) {
      userMessage = err.message; // Use the trigger message directly
    } else if (err.message?.includes('JWT')) {
      userMessage = 'Your session has expired. Please log in again.';
    }

    toast.error(userMessage);
    throw err; // Re-throw so callers can still handle if needed
  }
}
