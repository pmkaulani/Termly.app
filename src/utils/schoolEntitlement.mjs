/**
 * Pure school-access decision shared by the UI and portal login flows.
 * A perpetual licence removes subscription expiry; it does not override a
 * suspension or an inactive school workspace.
 */
export function isSchoolAccessActive(profile, now = new Date()) {
  if (!profile) return false;

  // Platform administrators are governed by their platform identity.
  if (profile.subscriptionPlan === 'Platform Admin' || profile.subscription_plan === 'Platform Admin') {
    return true;
  }

  const status = String(profile.subscriptionStatus || profile.subscription_status || '').toLowerCase().trim();
  const plan = String(profile.subscriptionPlan || profile.subscription_plan || '').toLowerCase().trim();
  const licenseType = String(profile.licenseType || profile.license_type || 'subscription').toLowerCase().trim();
  const licenseStatus = String(profile.licenseStatus || profile.license_status || '').toLowerCase().trim();

  if (licenseType === 'perpetual') {
    // Require the signed licence, the workspace and its stored subscription
    // status to be active. Never use support-through as an app expiry date.
    const workspaceStatus = String(profile.licenseWorkspaceStatus || profile.license_workspace_status || status).toLowerCase().trim();
    const profileStatus = String(profile.licenseSubscriptionStatus || profile.license_subscription_status || status).toLowerCase().trim();
    return licenseStatus === 'active' && status === 'active'
      && workspaceStatus === 'active' && profileStatus === 'active';
  }

  if (!status || ['inactive', 'deactivated', 'suspended', 'expired'].includes(status)) {
    return false;
  }

  if (status !== 'active' && plan !== 'sandbox') {
    return false;
  }

  const expiry = profile.subscriptionExpiry || profile.subscription_expiry;
  if (expiry) {
    const expDate = new Date(expiry);
    if (Number.isNaN(expDate.getTime())) return false;
    expDate.setHours(23, 59, 59, 999);
    if (expDate < now) return false;
  }

  return true;
}

export function getSchoolLicenceLabel(profile) {
  const type = String(profile?.licenseType || profile?.license_type || 'subscription').toLowerCase();
  const status = String(profile?.licenseStatus || profile?.license_status || '').toLowerCase();
  if (type === 'perpetual' && status === 'active') return 'Perpetual';
  if (type === 'perpetual' && status === 'suspended') return 'Perpetual · Suspended';
  return 'Subscription';
}
