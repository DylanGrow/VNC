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
  
  public get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // DOM Bindings
  private elBadge: HTMLElement | null = null;
  private elText: HTMLElement | null = null;
  private elCanvas: HTMLElement | null = null;
  private elPlaceholder: HTMLElement | null = null;
  private elSidebar: HTMLElement | null = null;
  private elHUD: HTMLElement | null = null;

  // Collaboration and Media properties
  public onPresenceUpdate: ((data: any) => void) | null = null;
  private _audioMuted = false;
  public get audioMuted(): boolean {
    return this._audioMuted;
  }
  public set audioMuted(val: boolean) {
    this._audioMuted = val;
    if (this.remoteAudio) {
      this.remoteAudio.muted = val;
    }
  }
  private audioCtx: AudioContext | null = null;
  private nextAudioTime = 0;
  private pc: RTCPeerConnection | null = null;
  private remoteVideo: HTMLVideoElement | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private videoRenderLoopId: number | null = null;

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
    if (this.videoRenderLoopId !== null) {
      window.cancelAnimationFrame(this.videoRenderLoopId);
      this.videoRenderLoopId = null;
    }
    if (this.remoteVideo) {
      try {
        this.remoteVideo.pause();
        this.remoteVideo.srcObject = null;
        this.remoteVideo.remove();
      } catch (ex) {}
      this.remoteVideo = null;
    }
    if (this.remoteAudio) {
      try {
        this.remoteAudio.pause();
        this.remoteAudio.srcObject = null;
        this.remoteAudio.remove();
      } catch (ex) {}
      this.remoteAudio = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
    this.nextAudioTime = 0;
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
            
            // Send matching response back immediately with RTT payload
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              const rtt = this.metrics.recordPong(id);
              this.ws.send(JSON.stringify({ type: 'pong', id, rtt }));
              if (rtt !== null) {
                this.adjustQualityBasedOnRTT(rtt);
                this.renderer.drawSparkline('sparkline-canvas', this.metrics.rttHistory);
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

      // Check for auth policy violation (code 1008) with invalid/missing token reason
      const isAuthError = event.code === 1008 && 
        (event.reason.toLowerCase().includes('token') || event.reason.toLowerCase().includes('credential'));

      if (isAuthError) {
        console.error('[VNC Connection] Authentication failed. Stopping reconnection.');
        this.token = null;
        document.cookie = "access_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        this.updateUIState('disconnected');
        window.dispatchEvent(new CustomEvent('vnc-auth-required', { detail: event.reason }));
      } else if (this.token) {
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

      this.pc.onconnectionstatechange = () => {
        console.info('[VNC Connection] WebRTC state change:', this.pc?.connectionState);
        if (this.pc?.connectionState === 'failed') {
          console.warn('[VNC Connection] WebRTC connection failed. Falling back to WebSocket.');
          const el = document.getElementById('hud-protocol');
          if (el) el.textContent = 'WS (TCP) - Fallback';
          if (this.pc) {
            this.pc.close();
            this.pc = null;
          }
        }
      };

      // Request transceivers to receive video and audio media streams from the host
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      this.pc.addTransceiver('audio', { direction: 'recvonly' });

      this.pc.ontrack = (event) => {
        console.info('[VNC Connection] WebRTC media track received:', event.track.kind);
        if (event.track.kind === 'video') {
          if (!this.remoteVideo) {
            this.remoteVideo = document.createElement('video');
            this.remoteVideo.autoplay = true;
            this.remoteVideo.playsInline = true;
            this.remoteVideo.muted = true;
            this.remoteVideo.style.display = 'none';
            document.body.appendChild(this.remoteVideo);
          }
          this.remoteVideo.srcObject = event.streams[0];
          
          const renderFrame = () => {
            if (this.remoteVideo && this.isConnected && this.remoteVideo.readyState >= this.remoteVideo.HAVE_CURRENT_DATA) {
              this.renderer.render(this.remoteVideo);
            }
            if (this.remoteVideo && this.isConnected) {
              this.videoRenderLoopId = window.requestAnimationFrame(renderFrame);
            }
          };

          this.remoteVideo.onloadedmetadata = () => {
            if (this.remoteVideo) {
              this.remoteVideo.play().catch((e) => console.debug('WebRTC play video failed:', e));
            }
            if (this.videoRenderLoopId !== null) {
              window.cancelAnimationFrame(this.videoRenderLoopId);
            }
            this.videoRenderLoopId = window.requestAnimationFrame(renderFrame);
          };
        } else if (event.track.kind === 'audio') {
          if (!this.remoteAudio) {
            this.remoteAudio = document.createElement('audio');
            this.remoteAudio.autoplay = true;
            this.remoteAudio.style.display = 'none';
            document.body.appendChild(this.remoteAudio);
          }
          this.remoteAudio.srcObject = event.streams[0];
          this.remoteAudio.muted = this.audioMuted;
          this.remoteAudio.play().catch((e) => console.debug('WebRTC play audio failed:', e));
        }
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
        // Apply 80ms jitter buffer offset when queue is empty or starting
        this.nextAudioTime = this.audioCtx.currentTime + 0.080;
      } else if (this.nextAudioTime - this.audioCtx.currentTime > 0.5) {
        console.warn(`[Audio] Drift detected: ${this.nextAudioTime - this.audioCtx.currentTime}s. Resetting queue.`);
        this.nextAudioTime = this.audioCtx.currentTime + 0.080;
      }
      source.start(this.nextAudioTime);
      this.nextAudioTime += bufferDuration;
    } catch (err) {
      console.debug('[VNC Connection] Audio playback failed:', err);
    }
  }

  /**
   * Transmits raw payloads over the active WebSocket connection.
   */
  public send(payload: any): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  /**
   * Manually sets the JPEG compression quality from the client UI.
   */
  public setQuality(quality: number) {
    this.lastQuality = quality;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'quality_adjust',
        quality: this.lastQuality,
        scale: this.lastScale
      }));
      console.info(`[VNC Connection] Manual quality adjust: set quality=${quality}%, scale=${this.lastScale}`);
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
          scale,
          rtt
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
      
      const hudChecked = (document.getElementById('chk-hud-toggle') as HTMLInputElement)?.checked ?? true;
      if (hudChecked) {
        this.elHUD?.classList.remove('hidden');
      } else {
        this.elHUD?.classList.add('hidden');
      }
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
