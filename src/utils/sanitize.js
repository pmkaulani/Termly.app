import DOMPurify from 'dompurify';

/**
 * Sanitizes input text before sending it to the database or processing.
 * - Trims leading/trailing whitespace
 * - Strips dangerous HTML tags to prevent XSS (Cross-Site Scripting)
 * - Limits overly long inputs
 */
export function sanitizeString(str, maxLength = 255) {
  if (!str) return '';
  if (typeof str !== 'string') return String(str);

  // 1. Remove ALL HTML tags using DOMPurify instead of weak regex
  let cleanStr = DOMPurify.sanitize(str, { ALLOWED_TAGS: [] });

  // 2. Trim padding spaces (e.g. "   John   " -> "John")
  cleanStr = cleanStr.trim();

  // 3. Enforce maximum length to prevent payload bloat
  if (cleanStr.length > maxLength) {
    cleanStr = cleanStr.slice(0, maxLength);
  }

  return cleanStr;
}

/**
 * Specifically formats person names (e.g. " john doe " -> "John Doe", with safe stripping)
 */
export function sanitizeName(str) {
  let s = sanitizeString(str, 100);
  // Title Case logic
  return s.split(' ')
    .filter(word => word.length > 0)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
