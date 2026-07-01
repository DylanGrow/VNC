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
  private btnAudioToggle: HTMLButtonElement;
  private svgAudioOn: HTMLElement;
  private svgAudioOff: HTMLElement;
  private txtAudio: HTMLElement;

  constructor() {
    // Instantiate sub-modules
    this.renderer = new CanvasRenderer('vnc-canvas');
    this.metrics = new MetricsTracker();
    this.connection = new ConnectionManager(this.renderer, this.metrics);
    this.input = new InputHandler(this.renderer.getCanvas(), (payload) => this.connection.send(payload));
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
    this.btnAudioToggle = document.getElementById('btn-audio-toggle') as HTMLButtonElement;
    this.svgAudioOn = document.getElementById('svg-audio-on') as HTMLElement;
    this.svgAudioOff = document.getElementById('svg-audio-off') as HTMLElement;
    this.txtAudio = document.getElementById('txt-audio') as HTMLElement;

    // Register Event Hooks
    this.formAuth.addEventListener('submit', (e) => this.handleLogin(e));
    this.btnLogout.addEventListener('click', () => this.handleLogout());
    this.selectMonitor.addEventListener('change', () => this.handleMonitorChange());
    this.sliderQuality.addEventListener('input', () => this.handleQualityChange());
    this.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
    this.btnAudioToggle.addEventListener('click', () => this.toggleAudio());

    // Virtual keyboard combos
    document.getElementById('btn-key-ctrlaltdel')?.addEventListener('click', () => this.sendKeyCombo(['ctrl', 'alt', 'delete']));
    document.getElementById('btn-key-alttab')?.addEventListener('click', () => this.sendKeyCombo(['alt', 'tab']));
    document.getElementById('btn-key-esc')?.addEventListener('click', () => this.sendKeyCombo(['escape']));
    document.getElementById('btn-key-tab')?.addEventListener('click', () => this.sendKeyCombo(['tab']));
    document.getElementById('btn-key-enter')?.addEventListener('click', () => this.sendKeyCombo(['enter']));
    document.getElementById('btn-key-backspace')?.addEventListener('click', () => this.sendKeyCombo(['backspace']));

    // Diagnostics HUD Visibility Toggle
    const hudToggle = document.getElementById('chk-hud-toggle') as HTMLInputElement;
    hudToggle?.addEventListener('change', () => {
      const isVisible = hudToggle.checked;
      localStorage.setItem('vnc_hud_visible', isVisible ? 'true' : 'false');
      const hud = document.getElementById('metrics-hud');
      if (hud) {
        if (isVisible && this.connection.isConnected) {
          hud.classList.remove('hidden');
        } else {
          hud.classList.add('hidden');
        }
      }
    });

    // Help modal event hooks
    const helpModal = document.getElementById('help-modal');
    document.getElementById('btn-help')?.addEventListener('click', () => {
      helpModal?.classList.remove('hidden');
    });
    document.getElementById('btn-help-close')?.addEventListener('click', () => {
      helpModal?.classList.add('hidden');
    });
    document.getElementById('btn-help-ok')?.addEventListener('click', () => {
      helpModal?.classList.add('hidden');
    });

    // Theme selector event hooks
    document.getElementById('theme-indigo')?.addEventListener('click', () => this.setTheme('indigo'));
    document.getElementById('theme-emerald')?.addEventListener('click', () => this.setTheme('emerald'));
    document.getElementById('theme-rose')?.addEventListener('click', () => this.setTheme('rose'));

    // Collapsible Tools Sidebar Toggle
    const btnToggleHelper = document.getElementById('btn-toggle-helper');
    const helperPanel = document.getElementById('helper-panel');
    
    // Restore sidebar state from preferences
    const isHelperCollapsed = localStorage.getItem('vnc_helper_collapsed') === 'true';
    if (helperPanel) {
      if (isHelperCollapsed) {
        helperPanel.classList.add('hidden');
        btnToggleHelper?.classList.remove('bg-brand-600', 'text-white');
        btnToggleHelper?.classList.add('bg-slate-700', 'text-slate-300');
      } else {
        helperPanel.classList.remove('hidden');
        btnToggleHelper?.classList.add('bg-brand-600', 'text-white');
        btnToggleHelper?.classList.remove('bg-slate-700', 'text-slate-300');
      }
    }

    btnToggleHelper?.addEventListener('click', () => {
      if (helperPanel) {
        const isHidden = helperPanel.classList.contains('hidden');
        if (isHidden) {
          helperPanel.classList.remove('hidden');
          localStorage.setItem('vnc_helper_collapsed', 'false');
          btnToggleHelper.classList.add('bg-brand-600', 'text-white');
          btnToggleHelper.classList.remove('bg-slate-700', 'text-slate-300');
        } else {
          helperPanel.classList.add('hidden');
          localStorage.setItem('vnc_helper_collapsed', 'true');
          btnToggleHelper.classList.remove('bg-brand-600', 'text-white');
          btnToggleHelper.classList.add('bg-slate-700', 'text-slate-300');
        }
      }
    });

    // Dropdown Popover Toggles
    const dropdowns = ['view', 'commands', 'themes'];
    dropdowns.forEach(dd => {
      const btn = document.getElementById(`menu-btn-${dd}`);
      const menu = document.getElementById(`menu-dropdown-${dd}`);
      
      btn?.addEventListener('click', (e) => {
        e.stopPropagation();
        // Hide others
        dropdowns.forEach(other => {
          if (other !== dd) {
            document.getElementById(`menu-dropdown-${other}`)?.classList.remove('show');
          }
        });
        menu?.classList.toggle('show');
      });
    });

    // Global click handler to close dropdowns
    const closeDropdowns = () => {
      dropdowns.forEach(dd => {
        document.getElementById(`menu-dropdown-${dd}`)?.classList.remove('show');
      });
    };
    document.addEventListener('click', closeDropdowns);
    window.addEventListener('vnc-menu-collapse', closeDropdowns);
    window.addEventListener('vnc-native-combo', (e: any) => {
      if (Array.isArray(e.detail)) {
        this.sendKeyCombo(e.detail);
      }
    });

    // Prevent closing when clicking inside active menus
    dropdowns.forEach(dd => {
      document.getElementById(`menu-dropdown-${dd}`)?.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });

    // Listen for WebSocket authentication policy violations
    window.addEventListener('vnc-auth-required', (e: any) => {
      const wasLoggedIn = this.token !== null;
      this.handleLogout();
      if (this.elAuthError && wasLoggedIn) {
        this.elAuthError.textContent = `Session expired: ${e.detail || 'Please log in again'}`;
        this.elAuthError.classList.remove('hidden');
      }
    });

    // Connect remote presence indicators
    this.connection.onPresenceUpdate = (data) => this.handlePresenceUpdate(data);

    // Presence cursor cleanup cycle (Prunes inactive remote operator cursors after 5 seconds of silence)
    setInterval(() => {
      const now = Date.now();
      const timeout = 5000;
      this.remoteCursors.forEach((el, username) => {
        const lastUpdate = parseInt(el.dataset.lastUpdate || '0', 10);
        if (now - lastUpdate > timeout) {
          el.remove();
          this.remoteCursors.delete(username);
        }
      });
    }, 2000);

    // Restore user-customized options and check for active session
    this.restoreState();
    this.checkSessionRecovery();
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
        
        // Show audio toggle controls
        this.btnAudioToggle.classList.remove('hidden');
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
    
    // Hide audio toggle controls
    this.btnAudioToggle.classList.add('hidden');

    // Hide diagnostics HUD on logout
    const hud = document.getElementById('metrics-hud');
    if (hud) {
      hud.classList.add('hidden');
    }

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
        const infoMon = document.getElementById('info-monitor');
        if (infoMon) infoMon.textContent = this.monitorId.toString();
      }
    } catch (err) {
      console.error('[VNC App] Failed to query monitors list:', err);
    }
  }

  private handleMonitorChange() {
    const val = parseInt(this.selectMonitor.value, 10);
    if (!isNaN(val)) {
      this.monitorId = val;
      this.connection.setMonitorId(this.monitorId);
      this.input.setMonitorId(this.monitorId);
      localStorage.setItem('vnc_monitor_id', this.monitorId.toString());
      const infoMon = document.getElementById('info-monitor');
      if (infoMon) infoMon.textContent = this.monitorId.toString();
    }
  }

  private handleQualityChange() {
    const quality = parseInt(this.sliderQuality.value, 10);
    this.valQuality.textContent = `${quality}%`;
    localStorage.setItem('vnc_quality', quality.toString());
    this.connection.setQuality(quality);
  }

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

  private handlePresenceUpdate(data: { username: string; x: number; y: number; role: string }) {
    if (data.username === this.username) {
      return;
    }

    let cursorEl = this.remoteCursors.get(data.username);
    if (!cursorEl) {
      cursorEl = document.createElement('div');
      cursorEl.className = 'absolute pointer-events-none z-50 flex items-center space-x-1 transition-all duration-75';
      cursorEl.innerHTML = `
        <div class="h-3 w-3 rounded-full bg-brand-500 border border-white"></div>
        <span class="bg-slate-900/90 border border-slate-700 text-[10px] text-brand-300 px-1 py-0.5 rounded shadow">${data.username} (${data.role})</span>
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
      cursorEl.dataset.lastUpdate = Date.now().toString();
      cursorEl.classList.remove('hidden');
    }
  }

  private toggleAudio(forceState?: boolean) {
    if (forceState !== undefined) {
      this.connection.audioMuted = forceState;
    } else {
      this.connection.audioMuted = !this.connection.audioMuted;
    }
    localStorage.setItem('vnc_audio_muted', this.connection.audioMuted ? 'true' : 'false');
    if (this.connection.audioMuted) {
      this.svgAudioOn.classList.add('hidden');
      this.svgAudioOff.classList.remove('hidden');
      this.txtAudio.textContent = 'Audio Muted';
      this.btnAudioToggle.classList.remove('text-slate-200');
      this.btnAudioToggle.classList.add('text-slate-500');
    } else {
      this.svgAudioOn.classList.remove('hidden');
      this.svgAudioOff.classList.add('hidden');
      this.txtAudio.textContent = 'Audio ON';
      this.btnAudioToggle.classList.remove('text-slate-500');
      this.btnAudioToggle.classList.add('text-slate-200');
    }
  }

  private setTheme(theme: 'indigo' | 'emerald' | 'rose') {
    document.documentElement.className = document.documentElement.className.replace(/\btheme-\S+/g, '');
    if (theme !== 'indigo') {
      document.documentElement.classList.add(`theme-${theme}`);
    }
    localStorage.setItem('vnc_theme', theme);

    // Update active button styles
    const themes: ('indigo' | 'emerald' | 'rose')[] = ['indigo', 'emerald', 'rose'];
    themes.forEach(t => {
      const btn = document.getElementById(`theme-${t}`);
      if (btn) {
        if (t === theme) {
          btn.classList.add('bg-brand-600/30', 'border-brand-500/30');
          btn.classList.remove('border-transparent');
        } else {
          btn.classList.remove('bg-brand-600/30', 'border-brand-500/30');
          btn.classList.add('border-transparent');
        }
      }
    });
  }

  private restoreState() {
    // Restore Theme
    const savedTheme = localStorage.getItem('vnc_theme') || 'indigo';
    this.setTheme(savedTheme as 'indigo' | 'emerald' | 'rose');

    // Restore Quality
    const savedQuality = localStorage.getItem('vnc_quality');
    if (savedQuality) {
      this.sliderQuality.value = savedQuality;
      this.valQuality.textContent = `${savedQuality}%`;
    }

    // Restore Audio
    const savedAudio = localStorage.getItem('vnc_audio_muted');
    if (savedAudio !== null) {
      const isMuted = savedAudio === 'true';
      this.toggleAudio(isMuted);
    }

    // Restore HUD Toggle state
    const savedHUD = localStorage.getItem('vnc_hud_visible');
    const hudToggle = document.getElementById('chk-hud-toggle') as HTMLInputElement;
    if (hudToggle && savedHUD !== null) {
      hudToggle.checked = savedHUD === 'true';
      const hud = document.getElementById('metrics-hud');
      if (hud) {
        if (hudToggle.checked && this.connection.isConnected) {
          hud.classList.remove('hidden');
        } else {
          hud.classList.add('hidden');
        }
      }
    }
  }

  private async checkSessionRecovery() {
    try {
      // Use standard credentials to verify active session cookie
      const res = await fetch('/api/monitors', { credentials: 'same-origin' });
      if (res.ok) {
        // Authenticated! Trigger token refresh call to obtain active CSRF token
        const refreshRes = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin'
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          this.csrfToken = data.csrf_token || '';
          this.token = 'active_session';
          this.modalAuth.classList.add('hidden');
          this.btnLogout.classList.remove('hidden');

          // Restoring parameter values
          this.restoreState();

          await this.loadMonitors();

          // Restore monitor selection if saved
          const savedMonitor = localStorage.getItem('vnc_monitor_id');
          if (savedMonitor) {
            this.monitorId = parseInt(savedMonitor, 10);
            this.selectMonitor.value = savedMonitor;
          }

          this.connection.connect(this.token, this.monitorId);
          this.clipboard.setToken(this.token);
          this.clipboard.setCsrfToken(this.csrfToken);

          const role = data.role || 'operator';
          if (role === 'operator') {
            this.input.enable(this.token, this.monitorId, this.csrfToken);
            document.getElementById('btn-clipboard-send')?.removeAttribute('disabled');
          } else {
            this.input.disable();
            document.getElementById('btn-clipboard-send')?.setAttribute('disabled', 'true');
          }

          this.startTokenRefresh();
          this.btnAudioToggle.classList.remove('hidden');
        }
      }
    } catch (err) {
      console.debug('[VNC App] Session auto-recovery check failed:', err);
    }
  }

  private sendKeyCombo(keys: string[]) {
    if (!this.token) return;
    fetch('/api/input', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': this.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        type: 'key_combo',
        keys: keys,
        monitorId: this.monitorId
      })
    }).catch(err => console.error('[VNC App] Failed to send key combo:', err));
  }
}
