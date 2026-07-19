export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;

  // Pool of recyclable Image objects
  private imagePool: HTMLImageElement[] = [];
  private paintScheduled = false;

  constructor(canvasId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    const context = this.canvas.getContext('2d');
    if (!context) {
      throw new Error('Failed to retrieve 2D rendering context for main canvas');
    }
    this.ctx = context;

    // Offscreen Canvas for double-buffering
    this.offscreenCanvas = document.createElement('canvas');
    const offscreenContext = this.offscreenCanvas.getContext('2d');
    if (!offscreenContext) {
      throw new Error('Failed to retrieve 2D rendering context for offscreen buffer');
    }
    this.offscreenCtx = offscreenContext;

    // Pre-allocate 5 Image objects in the pool
    for (let i = 0; i < 5; i++) {
      this.imagePool.push(new Image());
    }
  }

  /**
   * Return the primary canvas DOM element.
   */
  public getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * Resizes the screen coordinate spaces to match the incoming frame source metrics.
   */
  public resize(width: number, height: number) {
    const dpr = window.devicePixelRatio || 1;
    const scaledWidth = width * dpr;
    const scaledHeight = height * dpr;

    if (this.canvas.width !== scaledWidth || this.canvas.height !== scaledHeight) {
      this.canvas.width = scaledWidth;
      this.canvas.height = scaledHeight;
      this.offscreenCanvas.width = scaledWidth;
      this.offscreenCanvas.height = scaledHeight;

      // Keep layout sizes at logical dimensions
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;

      const container = document.getElementById('canvas-container');
      if (container) {
        container.style.aspectRatio = `${width} / ${height}`;
      }

      // Set scale transforms to ensure crisp visuals
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  /**
   * Render an image onto the canvas using double buffering and requestAnimationFrame.
   */
  public render(img: HTMLImageElement | HTMLVideoElement, x = 0, y = 0, w?: number, h?: number, isDelta = false) {
    const imgW = (img as any).videoWidth !== undefined ? (img as any).videoWidth : (img as any).naturalWidth;
    const imgH = (img as any).videoHeight !== undefined ? (img as any).videoHeight : (img as any).naturalHeight;

    if (!isDelta) {
      this.resize(imgW, imgH);
      this.offscreenCtx.drawImage(img, 0, 0);
    } else {
      const drawW = w !== undefined ? w : imgW;
      const drawH = h !== undefined ? h : imgH;
      this.offscreenCtx.drawImage(img, x, y, drawW, drawH);
    }

    // Schedule paint of offscreen buffer to active canvas
    if (!this.paintScheduled) {
      this.paintScheduled = true;
      window.requestAnimationFrame(() => {
        // Paint 1-to-1 pixels from offscreen canvas to main canvas backing store
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.drawImage(this.offscreenCanvas, 0, 0);
        this.ctx.restore();
        this.paintScheduled = false;
      });
    }
  }

  /**
   * Borrow a pre-allocated Image instance, load the image source asynchronously,
   * and trigger the callback. The image is recycled later by the caller after rendering.
   */
  public decodeFrame(base64Data: string, onDone: (img: HTMLImageElement) => void, onError: () => void) {
    let img = this.imagePool.pop();
    if (!img) {
      img = new Image();
    }

    img.onload = () => {
      onDone(img!);
    };

    img.onerror = () => {
      onError();
      this.recycle(img!);
    };

    img.src = `data:image/jpeg;base64,${base64Data}`;
  }

  /**
   * Clean references and push back to pool.
   */
  public recycle(img: HTMLImageElement) {
    img.onload = null;
    img.onerror = null;
    
    // Safely clear src to release browser memory reference
    img.src = ''; 
    
    if (this.imagePool.length < 10) {
      this.imagePool.push(img);
    }
  }

  /**
   * Wipe canvases.
   */
  public clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);
    
    // Clear sparkline canvas too
    const sparkline = document.getElementById('sparkline-canvas') as HTMLCanvasElement;
    if (sparkline) {
      const ctx = sparkline.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, sparkline.width, sparkline.height);
    }
  }

  /**
   * Draws a latency sparkline chart inside a micro-canvas.
   */
  public drawSparkline(canvasId: string, values: number[]) {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    if (values.length < 2) {
      ctx.restore();
      return;
    }

    const maxVal = Math.max(...values, 100); 
    const minVal = Math.min(...values, 0);
    const range = maxVal - minVal;

    ctx.beginPath();
    ctx.strokeStyle = '#6366f1'; // Indigo-500
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((values[i] - minVal) / range) * (height - 6) - 3;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = 'rgba(99, 102, 241, 0.08)';
    ctx.fill();
    
    ctx.restore();
  }

  /**
   * Cleans up pooled Image instances, clears src reference pointers to free browser RAM,
   * resets callback listeners, and detaches canvas contexts for safe garbage collection.
   */
  public destroy() {
    this.clear();
    for (const img of this.imagePool) {
      img.onload = null;
      img.onerror = null;
      img.src = '';
    }
    this.imagePool = [];
    
    (this.ctx as any) = null;
    (this.offscreenCtx as any) = null;
    (this.canvas as any) = null;
    (this.offscreenCanvas as any) = null;
  }
}
