import { CanvasRenderer } from './renderer.ts';
import { MetricsTracker } from './metrics.ts';
import { ConnectionManager } from './connection.ts';
import { InputHandler } from './input-handler.ts';
import { ClipboardSync } from './clipboard.ts';

export class ScreenShareApp {
  private renderer: CanvasRenderer;
  private metrics: MetricsTracker;
  private connection: ConnectionManager;
  private input: InputHandler;
  private clipboard: ClipboardSync;

  private token: string | null = null;
  private monitorId = 1;
  private refreshIntervalId: number | null = null;
  private csrfToken = '';
  private username = '';
  private remoteCursors = new Map<string, HTMLElement>();

  // DOM Elements
  private formAuth: HTMLFormElement;
  private modalAuth: HTMLElement;
  private selectMonitor: HTMLSelectElement;
  private sliderQuality: HTMLInputElement;
  private valQuality: HTMLElement;
  private btnFullscreen: HTMLButtonElement;
  private btnLogout: HTMLButtonElement;
  private txtPassword: HTMLInputElement;
  private elAuthError: HTMLElement;
  private chkViewer: HTMLInputElement;

  constructor() {
    // Instantiate sub-modules
    this.renderer = new CanvasRenderer('vnc-canvas');
    this.metrics = new MetricsTracker();
    this.connection = new ConnectionManager(this.renderer, this.metrics);
    this.input = new InputHandler(this.renderer.getCanvas());
    this.clipboard = new ClipboardSync();

    // DOM Bindings
    this.formAuth = document.getElementById('auth-form') as HTMLFormElement;
    this.modalAuth = document.getElementById('auth-modal') as HTMLElement;
    this.selectMonitor = document.getElementById('select-monitor') as HTMLSelectElement;
    this.sliderQuality = document.getElementById('slider-quality') as HTMLInputElement;
    this.valQuality = document.getElementById('val-quality') as HTMLElement;
    this.btnFullscreen = document.getElementById('btn-fullscreen') as HTMLButtonElement;
    this.btnLogout = document.getElementById('btn-logout') as HTMLButtonElement;
    this.txtPassword = document.getElementById('password') as HTMLInputElement;
    this.elAuthError = document.getElementById('auth-error') as HTMLElement;
    this.chkViewer = document.getElementById('chk-viewer') as HTMLInputElement;

    // Register Event Hooks
    this.formAuth.addEventListener('submit', (e) => this.handleLogin(e));
    this.btnLogout.addEventListener('click', () => this.handleLogout());
    this.selectMonitor.addEventListener('change', () => this.handleMonitorChange());
    this.sliderQuality.addEventListener('input', () => this.handleQualityChange());
    this.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());

    // Connect remote presence indicators
    this.connection.onPresenceUpdate = (data) => this.handlePresenceUpdate(data);
  }

  /**
   * Submit credentials to API and open VNC stream.
   */
  private async handleLogin(e: Event) {
    e.preventDefault();
    const username = (document.getElementById('username') as HTMLInputElement).value;
    const password = this.txtPassword.value;
    const role = this.chkViewer.checked ? 'viewer' : 'operator';

    this.elAuthError.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password, role })
      });

      if (!res.ok) {
        throw new Error('Credentials rejected by server');
      }

      const data = await res.json();
      this.csrfToken = data.csrf_token || '';
      this.username = username;

      // Session is set inside HttpOnly cookie on response header
      this.token = 'active_session';

      if (this.token) {
        this.modalAuth.classList.add('hidden');
        this.btnLogout.classList.remove('hidden');

        // Dynamically load available displays
        await this.loadMonitors();

        // Establish WS stream
        this.connection.connect(this.token, this.monitorId);
        this.clipboard.setToken(this.token);
        this.clipboard.setCsrfToken(this.csrfToken);

        // Control interactive input availability based on role
        if (role === 'operator') {
          this.input.enable(this.token, this.monitorId, this.csrfToken);
          document.getElementById('btn-clipboard-send')?.removeAttribute('disabled');
        } else {
          this.input.disable();
          document.getElementById('btn-clipboard-send')?.setAttribute('disabled', 'true');
        }

        // Start background token rotation
        this.startTokenRefresh();
      }
    } catch (err) {
      console.error('[VNC App] Login exception:', err);
      this.elAuthError.classList.remove('hidden');
    }
  }

  /**
   * Destroys credentials token and disconnects from WS stream.
   */
  private handleLogout() {
    this.stopTokenRefresh();
    this.csrfToken = '';
    this.username = '';

    // Remove remote cursors overlays
    this.remoteCursors.forEach(el => el.remove());
    this.remoteCursors.clear();

    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .catch(err => console.error('[VNC App] Server sign out failed:', err));

    this.token = null;
    this.connection.disconnect();
    this.input.disable();
    this.clipboard.setToken(null);
    this.clipboard.setCsrfToken('');

    this.modalAuth.classList.remove('hidden');
    this.btnLogout.classList.add('hidden');
    this.txtPassword.value = '';
  }

  /**
   * Periodically rotates JWT session token in the background.
   */
  private async rotateToken() {
    if (!this.token || !this.csrfToken) {
      return;
    }
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': this.csrfToken
        },
        credentials: 'same-origin'
      });
      if (res.ok) {
        const data = await res.json();
        this.csrfToken = data.csrf_token || '';
        this.input.setCsrfToken(this.csrfToken);
        this.clipboard.setCsrfToken(this.csrfToken);
        console.info('[VNC App] Session token rotated successfully');
      } else {
        console.warn('[VNC App] Token rotation failed, signing out');
        this.handleLogout();
      }
    } catch (err) {
      console.error('[VNC App] Error rotating session token:', err);
    }
  }

  private startTokenRefresh() {
    this.stopTokenRefresh();
    // Rotate token every 12 minutes
    this.refreshIntervalId = window.setInterval(() => this.rotateToken(), 12 * 60 * 1000);
  }

  private stopTokenRefresh() {
    if (this.refreshIntervalId !== null) {
      window.clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }
  }

  /**
   * Fetch connected monitors from API.
   */
  private async loadMonitors() {
    if (!this.token) {
      return;
    }

    try {
      const res = await fetch('/api/monitors', {
        credentials: 'same-origin'
      });
      if (!res.ok) {
        throw new Error('Host rejected monitors query');
      }

      const payload = await res.json();
      const monitors = payload.monitors || [];

      // Clear existing monitor options
      this.selectMonitor.innerHTML = '';

      monitors.forEach((mon: { id: number; width: number; height: number; is_primary: boolean }) => {
        const opt = document.createElement('option');
        opt.value = mon.id.toString();
        opt.textContent = `Display ${mon.id} (${mon.width}x${mon.height})${mon.is_primary ? ' [Primary]' : ''}`;
        this.selectMonitor.appendChild(opt);
      });

      if (monitors.length > 0) {
        this.monitorId = monitors[0].id;
      }
    } catch (err) {
      console.error('[VNC App] Failed to query monitors list:', err);
    }
  }

  /**
   * Switch active monitor stream source.
   */
  private handleMonitorChange() {
    const val = parseInt(this.selectMonitor.value, 10);
    if (!isNaN(val)) {
      this.monitorId = val;
      this.connection.setMonitorId(this.monitorId);
      this.input.setMonitorId(this.monitorId);
    }
  }

  /**
   * Adjusts client slider visual.
   */
  private handleQualityChange() {
    const quality = this.sliderQuality.value;
    this.valQuality.textContent = `${quality}%`;
  }

  /**
   * Set Canvas container to full viewport.
   */
  private toggleFullscreen() {
    const container = document.getElementById('canvas-container');
    if (!container) {
      return;
    }

    if (!document.fullscreenElement) {
      container.requestFullscreen().catch(err => {
        console.error(`[VNC App] Fullscreen request rejected: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }

  /**
   * Render virtual remote cursor overlay representations.
   */
  private handlePresenceUpdate(data: { username: string; x: number; y: number; role: string }) {
    if (data.username === this.username) {
      return;
    }

    let cursorEl = this.remoteCursors.get(data.username);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'absolute pointer-events-none z-50 flex items-center space-x-1 transition-all duration-75';
      cursorEl.innerHTML = `
        <div class="h-3 w-3 rounded-full bg-indigo-500 border border-white"></div>
        <span class="bg-indigo-950/80 border border-indigo-500/30 text-[10px] text-indigo-300 px-1 py-0.5 rounded shadow">${data.username} (${data.role})</span>
      `;
      const container = document.getElementById('canvas-container');
      container?.appendChild(cursorEl);
      this.remoteCursors.set(data.username, cursorEl);
    }

    const rect = this.renderer.getCanvas().getBoundingClientRect();
    const parentRect = this.renderer.getCanvas().parentElement?.getBoundingClientRect();
    if (parentRect) {
      const canvasLeft = rect.left - parentRect.left;
      const canvasTop = rect.top - parentRect.top;
      const left = canvasLeft + data.x * rect.width;
      const top = canvasTop + data.y * rect.height;
      cursorEl.style.left = `${left}px`;
      cursorEl.style.top = `${top}px`;
      cursorEl.classList.remove('hidden');
    }
  }
}
