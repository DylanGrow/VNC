export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;

  // Pool of recyclable Image objects
  private imagePool: HTMLImageElement[] = [];

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

      // Set scale transforms to ensure crisp visuals
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.offscreenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  /**
   * Render an image onto the canvas using double buffering and requestAnimationFrame.
   */
  public render(img: HTMLImageElement, x = 0, y = 0, w?: number, h?: number, isDelta = false) {
    if (!isDelta) {
      this.resize(img.naturalWidth, img.naturalHeight);
      this.offscreenCtx.drawImage(img, 0, 0);
    } else {
      const drawW = w !== undefined ? w : img.naturalWidth;
      const drawH = h !== undefined ? h : img.naturalHeight;
      this.offscreenCtx.drawImage(img, x, y, drawW, drawH);
    }

    // Schedule paint of offscreen buffer to active canvas
    window.requestAnimationFrame(() => {
      // Paint 1-to-1 pixels from offscreen canvas to main canvas backing store
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.drawImage(this.offscreenCanvas, 0, 0);
      this.ctx.restore();
    });
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
  }
}
