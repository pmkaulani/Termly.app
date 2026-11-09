/*
 * Public per-install Termly configuration.
 * Safe to expose: this file must contain ONLY the Supabase URL and publishable/anon key.
 * Never put a service_role key, Supabase secret key, database password, JWT secret,
 * M-PESA secret, SMS API secret, or any other server credential in this file.
 * The school-hosted installer writes its values here before deployment.
 */
window.__TERMLY_RUNTIME_CONFIG__ = window.__TERMLY_RUNTIME_CONFIG__ || {};
