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
  private sessionTimerIntervalId: number | null = null;
  private sessionStartTime: number | null = null;
  private hardwareIntervalId: number | null = null;
  private auditIntervalId: number | null = null;
  private qualityDebounceTimer: number | null = null;
  private csrfToken = '';
  private username = '';
  private role = '';
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
    this.sliderQuality.addEventListener('input', () => this.handleQualityChangeDebounced());
    this.btnFullscreen.addEventListener('click', () => this.toggleFullscreen());
    this.btnAudioToggle.addEventListener('click', () => this.toggleAudio());

    // Virtual keyboard combos
    document.getElementById('btn-key-ctrlaltdel')?.addEventListener('click', () => this.sendKeyCombo(['ctrl', 'alt', 'delete']));
    document.getElementById('btn-key-alttab')?.addEventListener('click', () => this.sendKeyCombo(['alt', 'tab']));
    document.getElementById('btn-key-esc')?.addEventListener('click', () => this.sendKeyCombo(['escape']));
    document.getElementById('btn-key-tab')?.addEventListener('click', () => this.sendKeyCombo(['tab']));
    document.getElementById('btn-key-enter')?.addEventListener('click', () => this.sendKeyCombo(['enter']));
    document.getElementById('btn-key-backspace')?.addEventListener('click', () => this.sendKeyCombo(['backspace']));
    document.getElementById('btn-key-wind')?.addEventListener('click', () => this.sendKeyCombo(['super', 'd']));
    document.getElementById('btn-key-winl')?.addEventListener('click', () => this.sendKeyCombo(['super', 'l']));
    document.getElementById('btn-key-ctrla')?.addEventListener('click', () => this.sendKeyCombo(['ctrl', 'a']));

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
    const openHelp = () => helpModal?.classList.remove('hidden');
    const closeHelp = () => helpModal?.classList.add('hidden');
    document.getElementById('btn-help')?.addEventListener('click', openHelp);
    document.getElementById('btn-help-close')?.addEventListener('click', closeHelp);
    document.getElementById('btn-help-ok')?.addEventListener('click', closeHelp);
    // '?' key shortcut opens help
    document.addEventListener('keydown', (e) => {
      if (e.key === '?' && !this.token) return; // only when connected
      if (e.key === '?' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        helpModal?.classList.toggle('hidden');
      }
      if (e.key === 'Escape') closeHelp();
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

    // Terminal Command Runner Bindings
    const btnTermRun = document.getElementById('btn-terminal-run');
    const txtTermCmd = document.getElementById('txt-terminal-cmd') as HTMLInputElement;
    const preTermOutput = document.getElementById('pre-terminal-output');

    const runTerminalCommand = async () => {
      if (!this.token) return;
      const command = txtTermCmd?.value.trim();
      if (!command) return;

      if (btnTermRun) {
        btnTermRun.setAttribute('disabled', 'true');
        btnTermRun.textContent = '...';
      }
      if (preTermOutput) {
        preTermOutput.classList.remove('hidden');
        preTermOutput.textContent = 'Executing command on Host...\n';
      }

      try {
        const res = await fetch('/api/terminal/execute', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': this.csrfToken
          },
          credentials: 'same-origin',
          body: JSON.stringify({ command })
        });
        const data = await res.json();
        if (preTermOutput) {
          preTermOutput.textContent = data.output || 'Command completed with no output.';
          preTermOutput.scrollTop = preTermOutput.scrollHeight;
        }
      } catch (err: any) {
        if (preTermOutput) {
          preTermOutput.textContent = `Error: ${err.message || err}`;
        }
      } finally {
        if (btnTermRun) {
          btnTermRun.removeAttribute('disabled');
          btnTermRun.textContent = 'Run';
        }
      }
    };

    btnTermRun?.addEventListener('click', runTerminalCommand);
    txtTermCmd?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        runTerminalCommand();
      }
    });

    // Drag and Drop File Upload Bindings
    const canvasContainer = document.getElementById('canvas-container');
    const uploadOverlay = document.getElementById('upload-overlay');
    const uploadStatusText = document.getElementById('upload-status-text');
    const uploadProgressText = document.getElementById('upload-progress-text');

    let dragCounter = 0;

    canvasContainer?.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (this.token && uploadOverlay) {
        uploadOverlay.classList.remove('hidden');
      }
    });

    canvasContainer?.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    canvasContainer?.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0 && uploadOverlay) {
        uploadOverlay.classList.add('hidden');
        dragCounter = 0;
      }
    });

    canvasContainer?.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      if (uploadOverlay) uploadOverlay.classList.add('hidden');

      if (!this.token) {
        this.showToast('You must be authenticated to upload files.', 'error');
        return;
      }

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      const file = files[0];
      
      // Open overlay to show progress
      if (uploadOverlay && uploadStatusText && uploadProgressText) {
        uploadStatusText.textContent = `Uploading ${file.name}...`;
        uploadProgressText.textContent = '0%';
        uploadOverlay.classList.remove('hidden');
      }

      try {
        const formData = new FormData();
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/file/upload', true);
        xhr.setRequestHeader('X-CSRF-Token', this.csrfToken || '');

        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable) {
            const percentComplete = Math.round((evt.loaded / evt.total) * 100);
            if (uploadProgressText) {
              uploadProgressText.textContent = `${percentComplete}%`;
            }
          }
        };

        xhr.onload = () => {
          if (uploadOverlay) uploadOverlay.classList.add('hidden');
          if (xhr.status === 200 || xhr.status === 201) {
            this.showToast(`✓ File "${file.name}" uploaded to Downloads/`, 'success');
          } else {
            let errorMsg = 'Upload failed';
            try {
              const resJson = JSON.parse(xhr.responseText);
              errorMsg = resJson.detail || errorMsg;
            } catch (err) {}
            this.showToast(errorMsg, 'error');
          }
        };

        xhr.onerror = () => {
          if (uploadOverlay) uploadOverlay.classList.add('hidden');
          this.showToast('Network error during file upload', 'error');
        };

        xhr.send(formData);
      } catch (err: any) {
        if (uploadOverlay) uploadOverlay.classList.add('hidden');
        this.showToast(err.message || 'Failed to start file upload', 'error');
      }
    });

    document.getElementById('btn-hardware-refresh')?.addEventListener('click', () => this.fetchSystemInfo());
    document.getElementById('btn-audit-refresh')?.addEventListener('click', () => this.fetchAuditLogs());

    // Restore user-customized options and check for active session
    this.restoreState();
    this.checkSessionRecovery();
  }

  private startSessionTimer() {
    this.sessionStartTime = Date.now();
    this.stopSessionTimer();
    const timerEl = document.getElementById('session-timer');
    if (timerEl) timerEl.classList.remove('hidden');
    this.sessionTimerIntervalId = window.setInterval(() => {
      if (!this.sessionStartTime) return;
      const elapsed = Math.floor((Date.now() - this.sessionStartTime) / 1000);
      const h = Math.floor(elapsed / 3600).toString().padStart(2, '0');
      const m = Math.floor((elapsed % 3600) / 60).toString().padStart(2, '0');
      const s = (elapsed % 60).toString().padStart(2, '0');
      const el = document.getElementById('session-timer-text');
      if (el) el.textContent = `${h}:${m}:${s}`;
    }, 1000);
    this.startHardwarePolling();
  }

  private stopSessionTimer() {
    if (this.sessionTimerIntervalId !== null) {
      window.clearInterval(this.sessionTimerIntervalId);
      this.sessionTimerIntervalId = null;
    }
    this.sessionStartTime = null;
    const timerEl = document.getElementById('session-timer');
    if (timerEl) timerEl.classList.add('hidden');
    this.stopHardwarePolling();
  }

  private showToast(message: string, type: 'info' | 'warn' | 'error' | 'success' = 'info') {
    const existing = document.getElementById('vnc-toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = 'vnc-toast';
    const colors = type === 'error' ? 'bg-red-950/90 border-red-500/35 text-red-200'
      : type === 'warn' ? 'bg-amber-950/90 border-amber-500/35 text-amber-200'
      : type === 'success' ? 'bg-emerald-950/90 border-emerald-500/35 text-emerald-200'
      : 'bg-slate-900/95 border-slate-700/60 text-slate-200';
    toast.className = `fixed bottom-6 right-6 z-[200] px-4 py-2.5 rounded-lg border shadow-2xl text-xs font-medium backdrop-blur transition-all duration-300 ${colors}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3500);
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

    // Show loading spinner on submit button
    const submitBtn = this.formAuth.querySelector('button[type="submit"]') as HTMLButtonElement;
    const originalBtnText = submitBtn?.textContent || 'Unlock Console';
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Connecting...';
      submitBtn.classList.add('opacity-75', 'cursor-not-allowed');
    }

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
        this.role = role;
        if (role === 'operator') {
          this.input.enable(this.token, this.monitorId, this.csrfToken);
          document.getElementById('btn-clipboard-send')?.removeAttribute('disabled');
        } else {
          this.input.disable();
          document.getElementById('btn-clipboard-send')?.setAttribute('disabled', 'true');
        }

        // Start background token rotation and session timer
        this.startTokenRefresh();
        this.startSessionTimer();
        document.title = `Connected — ScreenConnect Console`;
        this.showToast(`✓ Session started as ${role}`, 'info');

        if (this.role === 'administrator') {
          this.startAuditLogsPolling();
        } else {
          this.stopAuditLogsPolling();
        }
        
        // Show audio toggle controls
        this.btnAudioToggle.classList.remove('hidden');
      }
    } catch (err) {
      console.error('[VNC App] Login exception:', err);
      this.elAuthError.classList.remove('hidden');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        submitBtn.classList.remove('opacity-75', 'cursor-not-allowed');
      }
    }
  }

  /**
   * Destroys credentials token and disconnects from WS stream.
   */
  private handleLogout() {
    this.stopTokenRefresh();
    this.stopSessionTimer();
    this.stopAuditLogsPolling();
    this.csrfToken = '';
    this.username = '';
    this.role = '';

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
    if (hud) hud.classList.add('hidden');

    document.title = 'ScreenConnect Console';
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


  private handleQualityChangeDebounced() {
    const quality = parseInt(this.sliderQuality.value, 10);
    this.valQuality.textContent = `${quality}%`;
    if (this.qualityDebounceTimer !== null) window.clearTimeout(this.qualityDebounceTimer);
    this.qualityDebounceTimer = window.setTimeout(() => {
      localStorage.setItem('vnc_quality', quality.toString());
      this.connection.setQuality(quality);
    }, 250);
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
          this.role = role;
          if (role === 'operator') {
            this.input.enable(this.token, this.monitorId, this.csrfToken);
            document.getElementById('btn-clipboard-send')?.removeAttribute('disabled');
          } else {
            this.input.disable();
            document.getElementById('btn-clipboard-send')?.setAttribute('disabled', 'true');
          }

          this.startTokenRefresh();
          this.startSessionTimer();
          document.title = `Connected — ScreenConnect Console`;

          if (this.role === 'administrator') {
            this.startAuditLogsPolling();
          } else {
            this.stopAuditLogsPolling();
          }

          // Restore audio mute state on session recovery
          const savedAudio = localStorage.getItem('vnc_audio_muted');
          if (savedAudio !== null) this.toggleAudio(savedAudio === 'true');

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

  private async fetchSystemInfo() {
    if (!this.token) return;
    try {
      const res = await fetch('/api/system/info', {
        headers: {
          'X-CSRF-Token': this.csrfToken || ''
        },
        credentials: 'same-origin'
      });
      if (res.status === 401) return;
      const data = await res.json();
      
      const elOs = document.getElementById('hw-os');
      const elCpu = document.getElementById('hw-cpu');
      const elLblRam = document.getElementById('lbl-hw-ram');
      const elBarRam = document.getElementById('bar-hw-ram');
      const elLblDisk = document.getElementById('lbl-hw-disk');
      const elBarDisk = document.getElementById('bar-hw-disk');

      if (elOs) elOs.textContent = data.os || 'Unknown OS';
      if (elCpu) {
        elCpu.textContent = data.cpu || 'Unknown CPU';
        elCpu.title = data.cpu || '';
      }

      if (data.memory) {
        const mem = data.memory;
        if (elLblRam) elLblRam.textContent = `${mem.used_gb.toFixed(1)} / ${mem.total_gb.toFixed(1)} GB (${mem.percent.toFixed(0)}%)`;
        if (elBarRam) {
          elBarRam.style.width = `${mem.percent}%`;
          elBarRam.className = `h-full rounded transition-all duration-500 ` + 
            (mem.percent > 85 ? 'bg-rose-500' : mem.percent > 65 ? 'bg-amber-500' : 'bg-brand-500');
        }
      }

      if (data.storage) {
        const disk = data.storage;
        if (elLblDisk) elLblDisk.textContent = `${disk.used_gb.toFixed(1)} / ${disk.total_gb.toFixed(1)} GB (${disk.percent.toFixed(0)}%)`;
        if (elBarDisk) {
          elBarDisk.style.width = `${disk.percent}%`;
          elBarDisk.className = `h-full rounded transition-all duration-500 ` + 
            (disk.percent > 90 ? 'bg-rose-500' : disk.percent > 75 ? 'bg-amber-500' : 'bg-brand-500');
        }
      }
    } catch (err) {
      console.debug('[VNC App] Failed to fetch system info:', err);
    }
  }

  private startHardwarePolling() {
    this.stopHardwarePolling();
    this.fetchSystemInfo();
    this.hardwareIntervalId = window.setInterval(() => this.fetchSystemInfo(), 10000);
  }

  private stopHardwarePolling() {
    if (this.hardwareIntervalId) {
      clearInterval(this.hardwareIntervalId);
      this.hardwareIntervalId = null;
    }
  }

  private async fetchAuditLogs() {
    if (!this.token || this.role !== 'administrator') return;
    try {
      const res = await fetch('/api/audit/logs', {
        headers: {
          'X-CSRF-Token': this.csrfToken || ''
        },
        credentials: 'same-origin'
      });
      if (res.status === 401 || res.status === 403) {
        this.stopAuditLogsPolling();
        return;
      }
      const data = await res.json();
      const listEl = document.getElementById('audit-log-list');
      if (!listEl) return;
      
      if (!Array.isArray(data) || data.length === 0) {
        listEl.innerHTML = '<div class="text-slate-600 text-center py-2">No security events loaded.</div>';
        return;
      }

      listEl.innerHTML = data.map((event: any) => {
        const date = new Date(event.timestamp);
        const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        
        let typeBadge = '';
        let rowColor = 'text-slate-400';
        
        if (event.event_type.includes('fail') || event.event_type.includes('block') || event.event_type.includes('violation')) {
          typeBadge = `<span class="text-[8px] bg-rose-950/85 text-rose-400 border border-rose-900 px-1 py-0.2 rounded font-bold uppercase">SEC</span>`;
          rowColor = 'text-rose-350';
        } else if (event.event_type.includes('success') || event.event_type.includes('start')) {
          typeBadge = `<span class="text-[8px] bg-emerald-950/80 text-emerald-400 border border-emerald-900 px-1 py-0.2 rounded font-bold uppercase">OK</span>`;
          rowColor = 'text-emerald-350';
        } else {
          typeBadge = `<span class="text-[8px] bg-slate-900 text-slate-400 border border-slate-700 px-1 py-0.2 rounded font-bold uppercase">SYS</span>`;
        }

        let detailsStr = '';
        if (event.details) {
          detailsStr = Object.entries(event.details)
            .map(([k, v]) => `<span class="text-slate-500">${k}:</span>${v}`)
            .join(' ');
        }

        return `
          <div class="flex flex-col space-y-0.5 border-b border-slate-900/60 pb-1.5 last:border-0 ${rowColor}">
            <div class="flex items-center justify-between">
              <span class="text-[8px] text-slate-500 font-medium">${timeStr}</span>
              ${typeBadge}
            </div>
            <div class="text-[9px] font-semibold">${event.event_type}</div>
            <div class="text-[8px] font-mono text-slate-350 truncate leading-relaxed" title="${detailsStr.replace(/"/g, '&quot;')}">${detailsStr}</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      console.debug('[VNC App] Failed to fetch audit logs:', err);
    }
  }

  private startAuditLogsPolling() {
    this.stopAuditLogsPolling();
    const cardEl = document.getElementById('admin-audit-card');
    if (cardEl) cardEl.classList.remove('hidden');
    this.fetchAuditLogs();
    this.auditIntervalId = window.setInterval(() => this.fetchAuditLogs(), 8000);
  }

  private stopAuditLogsPolling() {
    if (this.auditIntervalId) {
      clearInterval(this.auditIntervalId);
      this.auditIntervalId = null;
    }
    const cardEl = document.getElementById('admin-audit-card');
    if (cardEl) cardEl.classList.add('hidden');
  }
}

