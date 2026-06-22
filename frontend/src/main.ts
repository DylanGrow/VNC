import { ScreenShareApp } from './app.ts';

// Bootstrap the application when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  console.info('[VNC Main] Bootstrapping VNC Client Application...');
  (window as any).vncApp = new ScreenShareApp();
});
