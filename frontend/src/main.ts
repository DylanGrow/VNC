import { ScreenShareApp } from './app.ts';

// Intercept HTTP 401/403 unauthorized states globally on fetch
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await originalFetch.apply(this, args);
  // Avoid intercepting the login request itself to allow natural validation error messages
  const isAuthUrl = typeof args[0] === 'string' && args[0].includes('/auth/login');
  if ((response.status === 401 || response.status === 403) && !isAuthUrl) {
    console.warn('[VNC Fetch] Intercepted unauthorized API status. Emitting auth-required event.');
    window.dispatchEvent(new CustomEvent('vnc-auth-required', { detail: 'Session unauthorized' }));
  }
  return response;
};

// Bootstrap the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  console.info('[VNC Main] Bootstrapping VNC Client Application...');
  (window as any).vncApp = new ScreenShareApp();
});
