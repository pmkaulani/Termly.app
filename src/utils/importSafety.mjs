/** Shared rules for safe legacy imports. */
export function hasImportValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasImportValue);
  return String(value).trim().length > 0;
}

export function normalizeTeacherImportStatus(value) {
  if (!hasImportValue(value)) return '';
  const key = String(value).trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const statuses = {
    active: 'Active', current: 'Active', employed: 'Active', working: 'Active',
    left: 'Left', departed: 'Left', resigned: 'Left', exited: 'Left',
    inactive: 'Inactive', disabled: 'Inactive', 'not active': 'Inactive',
    suspended: 'Suspended', retired: 'Retired',
    'on leave': 'On Leave', leave: 'On Leave'
  };
  return statuses[key] || null;
}
