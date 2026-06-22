import { MouseEventSchema, KeyboardEventSchema } from './validation.ts';

export class InputHandler {
  private canvas: HTMLCanvasElement;
  private monitorId = 1;
  private token: string | null = null;
  private enabled = false;
  private lastMoveTime = 0;
  private throttleMs = 33; // Limits movement data to ~30 calls per second

  // Caching Bounding dimensions to prevent layout thrashing
  private cachedRect: DOMRect | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Key tracking to suppress repeated duplicate events
  private activeKeys = new Set<string>();

  // Security Credentials
  private csrfToken = '';

  // Tap & Touch States
  private lastTapTime = 0;
  private touchStartTimer: number | null = null;

  // Local HUD overlays
  private elCursor: HTMLElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.elCursor = document.getElementById('virtual-cursor');
  }

  /**
   * Updates CSRF session token.
   */
  public setCsrfToken(csrfToken: string) {
    this.csrfToken = csrfToken;
  }

  /**
   * Activates DOM listeners for mouse actions, scrolling, and keyboard keystrokes.
   */
  public enable(token: string, monitorId: number, csrfToken = '') {
    this.token = token;
    this.monitorId = monitorId;
    this.csrfToken = csrfToken;

    if (this.enabled) {
      return;
    }
    this.enabled = true;

    // Cache initial boundary rectangle
    this.cachedRect = this.canvas.getBoundingClientRect();
    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this.cachedRect = entry.target.getBoundingClientRect();
      }
    });
    this.resizeObserver.observe(this.canvas);

    // Canvas Mouse listeners
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);

    // Canvas Touch listeners (for mobile support)
    this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });

    // Global document keyboard listeners
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);

    this.canvas.style.cursor = 'none';
  }

  /**
   * Deactivates all DOM event listeners.
   */
  public disable() {
    if (!this.enabled) {
      return;
    }
    this.enabled = false;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.cachedRect = null;
    this.activeKeys.clear();

    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('click', this.onClick);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);

    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    this.canvas.removeEventListener('touchend', this.onTouchEnd);

    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);

    if (this.elCursor) {
      this.elCursor.classList.add('hidden');
    }
    this.canvas.style.cursor = 'auto';
  }

  /**
   * Updates current target monitor resolution mappings.
   */
  public setMonitorId(id: number) {
    this.monitorId = id;
  }

  /**
   * Transforms cursor events into relative [0, 1] float bounds.
   */
  private getCoordinates(e: MouseEvent): { x: number; y: number } {
    const rect = this.cachedRect || this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    return { x, y };
  }

  /**
   * Asynchronously posts valid coordinates or key triggers.
   */
  private sendEvent(payload: unknown) {
    if (!this.enabled || !this.token) {
      return;
    }

    fetch('/api/input', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': this.csrfToken
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        ...(payload as Record<string, unknown>),
        monitorId: this.monitorId
      })
    }).catch(err => {
      console.error('[InputHandler] Failed to dispatch input action:', err);
    });
  }

  private onMouseMove = (e: MouseEvent) => {
    if (this.elCursor) {
      const parentRect = this.canvas.parentElement?.getBoundingClientRect();
      if (parentRect) {
        const left = e.clientX - parentRect.left;
        const top = e.clientY - parentRect.top;
        this.elCursor.style.left = `${left}px`;
        this.elCursor.style.top = `${top}px`;
        this.elCursor.classList.remove('hidden');
      }
    }

    const now = performance.now();
    if (now - this.lastMoveTime < this.throttleMs) {
      return;
    }
    this.lastMoveTime = now;

    const { x, y } = this.getCoordinates(e);
    const parsed = MouseEventSchema.safeParse({
      type: 'mouse_move',
      x,
      y,
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private onMouseDown = (e: MouseEvent) => {
    const { x, y } = this.getCoordinates(e);
    const buttonMap: Record<number, 'left' | 'middle' | 'right'> = {
      0: 'left',
      1: 'middle',
      2: 'right'
    };

    const parsed = MouseEventSchema.safeParse({
      type: 'mouse_down',
      x,
      y,
      button: buttonMap[e.button] || 'left',
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    const { x, y } = this.getCoordinates(e);
    const buttonMap: Record<number, 'left' | 'middle' | 'right'> = {
      0: 'left',
      1: 'middle',
      2: 'right'
    };

    const parsed = MouseEventSchema.safeParse({
      type: 'mouse_up',
      x,
      y,
      button: buttonMap[e.button] || 'left',
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private onClick = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onDoubleClick = (e: MouseEvent) => {
    const { x, y } = this.getCoordinates(e);
    const parsed = MouseEventSchema.safeParse({
      type: 'double_click',
      x,
      y,
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x, y } = this.getCoordinates(e);
    const parsed = MouseEventSchema.safeParse({
      type: 'scroll',
      x,
      y,
      deltaY: e.deltaY,
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const activeTagName = document.activeElement?.tagName;
    if (activeTagName === 'TEXTAREA' || activeTagName === 'INPUT') {
      return;
    }

    const key = this.normalizeKey(e.key);
    // Suppresses duplicate inputs when holding down keyboard keys
    if (this.activeKeys.has(key)) {
      return;
    }
    this.activeKeys.add(key);

    e.preventDefault();
    const parsed = KeyboardEventSchema.safeParse({
      type: 'key_press',
      key,
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const activeTagName = document.activeElement?.tagName;
    if (activeTagName === 'TEXTAREA' || activeTagName === 'INPUT') {
      return;
    }

    const key = this.normalizeKey(e.key);
    this.activeKeys.delete(key);

    e.preventDefault();
    const parsed = KeyboardEventSchema.safeParse({
      type: 'key_release',
      key,
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  /**
   * Normalizes browser keyboard keys to standard OS-level keys recognized by PyAutoGUI.
   */
  private normalizeKey(key: string): string {
    const map: Record<string, string> = {
      'Control': 'ctrl',
      'Shift': 'shift',
      'Alt': 'alt',
      'Meta': 'win',
      'ArrowUp': 'up',
      'ArrowDown': 'down',
      'ArrowLeft': 'left',
      'ArrowRight': 'right',
      'Escape': 'escape',
      'Enter': 'enter',
      'Backspace': 'backspace',
      'Tab': 'tab',
      'Delete': 'delete',
      'Insert': 'insert',
      'Home': 'home',
      'End': 'end',
      'PageUp': 'pageup',
      'PageDown': 'pagedown'
    };
    return map[key] || key;
  }

  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 0) {
      return;
    }
    const touch = e.touches[0];
    const { x, y } = this.getCoordinatesFromTouch(touch);
    
    const now = performance.now();
    const doubleTapThreshold = 300;
    
    // 1. Process Double-Tap to Double-Click
    if (now - this.lastTapTime < doubleTapThreshold) {
      this.lastTapTime = 0;
      if (this.touchStartTimer !== null) {
        window.clearTimeout(this.touchStartTimer);
        this.touchStartTimer = null;
      }
      
      const parsed = MouseEventSchema.safeParse({
        type: 'double_click',
        x,
        y,
        monitorId: this.monitorId
      });
      if (parsed.success) {
        this.sendEvent(parsed.data);
      }
      return;
    }
    
    this.lastTapTime = now;

    // 2. Set long-press timer to translate to right-click
    this.touchStartTimer = window.setTimeout(() => {
      this.touchStartTimer = null;
      const parsed = MouseEventSchema.safeParse({
        type: 'click',
        x,
        y,
        button: 'right',
        monitorId: this.monitorId
      });
      if (parsed.success) {
        this.sendEvent(parsed.data);
      }
    }, 500);

    // 3. Immediately send mouse down left
    const parsedDown = MouseEventSchema.safeParse({
      type: 'mouse_down',
      x,
      y,
      button: 'left',
      monitorId: this.monitorId
    });
    if (parsedDown.success) {
      this.sendEvent(parsedDown.data);
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 0) {
      return;
    }
    const touch = e.touches[0];
    
    // Clear long-press timers on movement
    if (this.touchStartTimer !== null) {
      window.clearTimeout(this.touchStartTimer);
      this.touchStartTimer = null;
    }

    if (this.elCursor) {
      const parentRect = this.canvas.parentElement?.getBoundingClientRect();
      if (parentRect) {
        const left = touch.clientX - parentRect.left;
        const top = touch.clientY - parentRect.top;
        this.elCursor.style.left = `${left}px`;
        this.elCursor.style.top = `${top}px`;
        this.elCursor.classList.remove('hidden');
      }
    }

    const now = performance.now();
    if (now - this.lastMoveTime < this.throttleMs) {
      return;
    }
    this.lastMoveTime = now;

    const { x, y } = this.getCoordinatesFromTouch(touch);
    const parsed = MouseEventSchema.safeParse({
      type: 'mouse_move',
      x,
      y,
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    e.preventDefault();
    
    // Release long press
    if (this.touchStartTimer !== null) {
      window.clearTimeout(this.touchStartTimer);
      this.touchStartTimer = null;
    }

    if (e.changedTouches.length === 0) {
      return;
    }
    const touch = e.changedTouches[0];
    const { x, y } = this.getCoordinatesFromTouch(touch);
    
    const parsed = MouseEventSchema.safeParse({
      type: 'mouse_up',
      x,
      y,
      button: 'left',
      monitorId: this.monitorId
    });

    if (parsed.success) {
      this.sendEvent(parsed.data);
    }
  };

  private getCoordinatesFromTouch(touch: Touch): { x: number; y: number } {
    const rect = this.cachedRect || this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (touch.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (touch.clientY - rect.top) / rect.height));
    return { x, y };
  }
}
