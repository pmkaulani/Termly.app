import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './pages/App.css'
import './index.css'
import './styles/termly-ui-refresh.css'
import { initStore } from './data/coreStore';
import { BrowserRouter, HashRouter } from 'react-router-dom';

const isElectron = navigator.userAgent.toLowerCase().includes('electron');
const Router = isElectron ? HashRouter : BrowserRouter;

import { HelmetProvider } from 'react-helmet-async';
import ScrollToTop from './components/ScrollToTop';
import { DialogProvider } from './contexts/DialogContext';
import OfflineDetector from './components/ErrorStates/OfflineDetector';

import { applySecurityHeaders } from './utils/securityUtils';
import { getTermlyRuntimeConfig, validateTermlyRuntimeConfig } from './lib/runtimeConfig';

// Apply the CSP using the selected cloud or school-hosted API endpoint.
applySecurityHeaders();

function validateEnv() {
  const config = getTermlyRuntimeConfig();
  const { errors } = validateTermlyRuntimeConfig(config);
  if (errors.length > 0) {
    const errorHtml = errors.map(error => `<li>${error}</li>`).join('');
    document.body.innerHTML = `
      <div style="padding: 50px; text-align: center; font-family: system-ui, sans-serif; color: #ef4444; max-width: 680px; margin: 0 auto;">
        <h2 style="margin-bottom: 16px;">Termly installation configuration required</h2>
        <ul style="text-align: left; line-height: 1.8;">${errorHtml}</ul>
        <p style="color: #71717a; margin-top: 24px;">
          Configure <code>termly-runtime-config.js</code> for this installation, or provide the cloud VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY values.
          Never place a Supabase secret/service-role key in browser configuration.
        </p>
      </div>
    `;
    throw new Error('Termly runtime configuration is invalid: ' + errors.join(' '));
  }
}

validateEnv();
initStore();

import * as Sentry from '@sentry/react';

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: false }),
    ],
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
  });
}

import { ErrorBoundary } from './components/ErrorBoundary';

const rootElement = document.getElementById('root');
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <HelmetProvider>
          <Router>
            <DialogProvider>
              <ScrollToTop />
              <OfflineDetector>
                <App />
              </OfflineDetector>
            </DialogProvider>
          </Router>
        </HelmetProvider>
      </ErrorBoundary>
    </React.StrictMode>
  );
} else {
  console.error('CRITICAL: Root element not found!');
}
