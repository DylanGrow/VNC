import { Reconnector } from './reconnection.ts';
import { FrameBuffer } from './frame-buffer.ts';
import { CanvasRenderer } from './renderer.ts';
import { MetricsTracker } from './metrics.ts';
import { FrameMessageSchema, PingMessageSchema } from './validation.ts';

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private monitorId = 1;
  private reconnector = new Reconnector();
  private frameBuffer = new FrameBuffer();
  private renderer: CanvasRenderer;
  private metrics: MetricsTracker;
  private lastQuality = 75;
  private lastScale = 1.0;

  // DOM Bindings
  private elBadge: HTMLElement | null = null;
  private elText: HTMLElement | null = null;
  private elCanvas: HTMLElement | null = null;
  private elPlaceholder: HTMLElement | null = null;
  private elSidebar: HTMLElement | null = null;
  private elHUD: HTMLElement | null = null;

  // Collaboration and Media properties
  public onPresenceUpdate: ((data: any) => void) | null = null;
  public audioMuted = false;
  private audioCtx: AudioContext | null = null;
  private nextAudioTime = 0;
  private pc: RTCPeerConnection | null = null;

  constructor(renderer: CanvasRenderer, metrics: MetricsTracker) {
    this.renderer = renderer;
    this.metrics = metrics;

    this.elBadge = document.getElementById('status-badge');
    this.elText = document.getElementById('status-text');
    this.elCanvas = document.getElementById('vnc-canvas');
    this.elPlaceholder = document.getElementById('canvas-placeholder');
    this.elSidebar = document.getElementById('control-panel');
    this.elHUD = document.getElementById('metrics-hud');
  }

  /**
   * Initialize a new socket session and reset states.
   */
  public connect(token: string, monitorId: number) {
    this.token = token;
    this.monitorId = monitorId;
    this.reconnector.reset();
    this.establishConnection();
  }

  /**
   * Terminate current socket stream and clear timers.
   */
  public disconnect() {
    this.token = null;
    this.reconnector.reset();
    this.frameBuffer.clear((frame) => this.renderer.recycle(frame.image));
    this.metrics.reset();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    const el = document.getElementById('hud-protocol');
    if (el) el.textContent = 'WS (TCP)';
    this.updateUIState('disconnected');
  }

  /**
   * Switches the active monitor target. Reconnects if session is active.
   */
  public setMonitorId(id: number) {
    if (this.monitorId !== id) {
      this.monitorId = id;
      if (this.ws && this.token) {
        console.info(`[VNC Connection] Switching visual monitor target to ID: ${id}`);
        this.establishConnection();
      }
    }
  }

  /**
   * Launches raw WebSocket and hooks listeners.
   */
  private establishConnection() {
    if (!this.token) {
      return;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.updateUIState('connecting');

    // Resolves ws/wss dynamically based on host protocol
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    
    // Connects through our Vite dev server proxy target path
    const wsUrl = `${protocol}//${host}/api/ws/screen/${this.monitorId}?token=${this.token}`;

    console.info(`[VNC Connection] Establishing WebSocket at: ${wsUrl}`);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.info('[VNC Connection] WebSocket connection successfully opened.');
      this.reconnector.reset();
      this.updateUIState('connected');
      this.negotiateWebRTC();
    };

    this.ws.onmessage = (event) => {
      try {
        const rawMsg = JSON.parse(event.data);

        // Frame update branch
        if (rawMsg.type === 'frame') {
          const parsed = FrameMessageSchema.safeParse(rawMsg);
          if (parsed.success) {
            const { sequence, data, x, y, w, h, is_delta } = parsed.data;
            
            // Decodes from pool and triggers drawing
            this.renderer.decodeFrame(
              data,
              (img) => {
                this.frameBuffer.addFrame(sequence, {
                  image: img,
                  x,
                  y,
                  w,
                  h,
                  isDelta: is_delta
                }, (readyFrame) => {
                  this.renderer.render(
                    readyFrame.image,
                    readyFrame.x,
                    readyFrame.y,
                    readyFrame.w,
                    readyFrame.h,
                    readyFrame.isDelta
                  );
                  this.renderer.recycle(readyFrame.image);
                  // Track payload bandwidth sizes (base64 * 0.75 roughly maps back to bytes size)
                  this.metrics.recordFrame(data.length * 0.75);
                }, (discardedFrame) => {
                  this.renderer.recycle(discardedFrame.image);
                });
              },
              () => {
                console.warn(`[VNC Connection] Error decoding image frame index: ${sequence}`);
                this.metrics.recordDrop();
              }
            );
          } else {
            console.warn('[VNC Connection] Frame data did not match the validation schema.');
          }
        } 
        
        // H.264 video_frame branch
        else if (rawMsg.type === 'video_frame') {
          this.renderer.decodeFrame(
            rawMsg.data,
            (img) => {
              this.renderer.render(img, 0, 0, img.naturalWidth, img.naturalHeight, false);
              this.renderer.recycle(img);
              this.metrics.recordFrame(rawMsg.data.length * 0.75);
            },
            () => {
              console.warn(`[VNC Connection] Error decoding H.264 video frame`);
              this.metrics.recordDrop();
            }
          );
        }

        // WebRTC answer branch
        else if (rawMsg.type === 'webrtc_answer') {
          const answer = rawMsg.answer;
          if (answer && answer.status === 'success') {
            this.handleWebRTCAnswer(answer.sdp, answer.type);
          }
        }

        // Audio streaming branch
        else if (rawMsg.type === 'audio') {
          this.playAudio(rawMsg.data, rawMsg.sampleRate || 44100, rawMsg.channels || 1);
        }

        // Operator presence update branch
        else if (rawMsg.type === 'presence') {
          if (this.onPresenceUpdate) {
            this.onPresenceUpdate(rawMsg);
          }
        }
        
        // Latency checker branch
        else if (rawMsg.type === 'ping') {
          const parsed = PingMessageSchema.safeParse(rawMsg);
          if (parsed.success) {
            const { id } = parsed.data;
            this.metrics.recordPing(id);
            
            // Send matching response back immediately
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ type: 'pong', id }));
              const rtt = this.metrics.recordPong(id);
              if (rtt !== null) {
                this.adjustQualityBasedOnRTT(rtt);
              }
            }
          }
        }
      } catch (err) {
        console.error('[VNC Connection] Payload exception occurred:', err);
      }
    };

    this.ws.onclose = (event) => {
      console.warn(`[VNC Connection] WebSocket closed. Status code: ${event.code}. Reason: ${event.reason}`);
      this.frameBuffer.clear((frame) => this.renderer.recycle(frame.image));
      if (this.pc) {
        this.pc.close();
        this.pc = null;
      }

      if (this.token) {
        this.updateUIState('connecting');
        this.reconnector.scheduleReconnect(() => this.establishConnection());
      } else {
        this.updateUIState('disconnected');
      }
    };

    this.ws.onerror = (err) => {
      console.error('[VNC Connection] Socket error encountered:', err);
    };
  }

  /**
   * Initializes and negotiates WebRTC connection via signaling.
   */
  private async negotiateWebRTC() {
    try {
      if (!window.RTCPeerConnection) {
        console.info('[VNC Connection] WebRTC is not supported in this browser.');
        return;
      }
      this.pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      this.pc.ontrack = (event) => {
        console.info('[VNC Connection] WebRTC media track received:', event.track.kind);
      };

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'webrtc_offer',
          sdp: offer.sdp,
          offer_type: offer.type
        }));
      }
    } catch (err) {
      console.warn('[VNC Connection] WebRTC negotiation failed:', err);
    }
  }

  private async handleWebRTCAnswer(sdp: string, type: RTCSdpType) {
    if (this.pc) {
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription({ sdp, type }));
        console.info('[VNC Connection] WebRTC signaling complete. Connection active.');
        const el = document.getElementById('hud-protocol');
        if (el) el.textContent = 'WebRTC (UDP)';
      } catch (err) {
        console.warn('[VNC Connection] Failed to set remote WebRTC description:', err);
      }
    }
  }

  /**
   * Plays PCM 16-bit audio loopback chunks in queue.
   */
  private playAudio(base64Data: string, sampleRate: number, channels: number) {
    if (this.audioMuted) {
      return;
    }
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
        this.nextAudioTime = this.audioCtx.currentTime;
      }

      const raw = window.atob(base64Data);
      const len = raw.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = raw.charCodeAt(i);
      }

      const data16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(data16.length);
      for (let i = 0; i < data16.length; i++) {
        float32[i] = data16[i] / 32768.0;
      }

      const audioBuffer = this.audioCtx.createBuffer(channels, float32.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      const bufferDuration = audioBuffer.duration;
      if (this.nextAudioTime < this.audioCtx.currentTime) {
        this.nextAudioTime = this.audioCtx.currentTime;
      }
      source.start(this.nextAudioTime);
      this.nextAudioTime += bufferDuration;
    } catch (err) {
      console.debug('[VNC Connection] Audio playback failed:', err);
    }
  }

  /**
   * Dynamically alters frame parameters if network latency triggers threshold boundaries.
   */
  private adjustQualityBasedOnRTT(rtt: number) {
    let quality = 75;
    let scale = 1.0;

    if (rtt > 180) {
      quality = 40;
      scale = 0.5;
    } else if (rtt > 95) {
      quality = 60;
      scale = 0.75;
    }

    if (quality !== this.lastQuality || scale !== this.lastScale) {
      this.lastQuality = quality;
      this.lastScale = scale;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'quality_adjust',
          quality,
          scale
        }));
        console.info(`[VNC Connection] Adaptive quality active: RTT=${rtt}ms. Set quality=${quality}%, scale=${scale}`);
      }
    }
  }

  /**
   * Refreshes DOM styles and display cards to match state.
   */
  private updateUIState(state: 'connected' | 'disconnected' | 'connecting') {
    if (!this.elBadge || !this.elText) {
      return;
    }

    this.elBadge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all duration-300';
    const dot = this.elBadge.querySelector('span');

    if (state === 'connected') {
      this.elBadge.classList.add('bg-emerald-500/10', 'text-emerald-400', 'border', 'border-emerald-500/25');
      this.elText.textContent = 'Connected';
      if (dot) {
        dot.className = 'h-2 w-2 rounded-full bg-emerald-500 animate-pulse';
      }
      this.elCanvas?.classList.remove('hidden');
      this.elPlaceholder?.classList.add('hidden');
      this.elSidebar?.classList.remove('hidden');
      this.elHUD?.classList.remove('hidden');
    } else if (state === 'connecting') {
      this.elBadge.classList.add('bg-amber-500/10', 'text-amber-400', 'border', 'border-amber-500/25');
      this.elText.textContent = 'Connecting...';
      if (dot) {
        dot.className = 'h-2 w-2 rounded-full bg-amber-500 animate-ping';
      }
      this.elCanvas?.classList.add('hidden');
      this.elPlaceholder?.classList.remove('hidden');
      this.elSidebar?.classList.add('hidden');
      this.elHUD?.classList.add('hidden');
    } else {
      this.elBadge.classList.add('bg-red-500/10', 'text-red-400', 'border', 'border-red-500/25');
      this.elText.textContent = 'Disconnected';
      if (dot) {
        dot.className = 'h-2 w-2 rounded-full bg-red-500 animate-none';
      }
      this.elCanvas?.classList.add('hidden');
      this.elPlaceholder?.classList.remove('hidden');
      this.elSidebar?.classList.add('hidden');
      this.elHUD?.classList.add('hidden');
      this.renderer.clear();
    }
  }
}
