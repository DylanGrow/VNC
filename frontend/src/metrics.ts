export class MetricsTracker {
  private frameCount = 0;
  private bytesCount = 0;
  private lastUpdate = performance.now();
  private drops = 0;

  // Stores timestamps of sent pings mapped by sequence ID
  private pingTimes = new Map<number, number>();

  // DOM bindings
  private elFps: HTMLElement | null = null;
  private elRtt: HTMLElement | null = null;
  private elBytes: HTMLElement | null = null;
  private elDrops: HTMLElement | null = null;

  constructor() {
    this.elFps = document.getElementById('hud-fps');
    this.elRtt = document.getElementById('hud-rtt');
    this.elBytes = document.getElementById('hud-bytes');
    this.elDrops = document.getElementById('hud-drops');
  }

  /**
   * Log rendering of a valid image frame.
   * Calculates rolling averages when crossing 1-second intervals.
   */
  public recordFrame(sizeBytes: number) {
    this.frameCount++;
    this.bytesCount += sizeBytes;
    this.tick();
  }

  /**
   * Record a frames-sequence skip or collision.
   */
  public recordDrop() {
    this.drops++;
    if (this.elDrops) {
      this.elDrops.textContent = this.drops.toString();
    }
  }

  /**
   * Capture timestamp when a ping is transmitted.
   */
  public recordPing(id: number) {
    this.pingTimes.set(id, performance.now());
  }

  public rttHistory: number[] = [];

  /**
   * Compute round-trip time difference upon receiving a matching pong.
   */
  public recordPong(id: number): number | null {
    const sentTime = this.pingTimes.get(id);
    if (sentTime !== undefined) {
      const rtt = Math.round(performance.now() - sentTime);
      if (this.elRtt) {
        this.elRtt.textContent = `${rtt} ms`;
      }
      this.pingTimes.delete(id);
      
      this.rttHistory.push(rtt);
      if (this.rttHistory.length > 30) {
        this.rttHistory.shift();
      }
      
      return rtt;
    }
    return null;
  }

  /**
   * Updates rates sliding window metrics.
   */
  private tick() {
    const now = performance.now();
    const elapsed = now - this.lastUpdate;
    if (elapsed >= 1000) {
      const fps = Math.round((this.frameCount * 1000) / elapsed);
      const kbps = Math.round((this.bytesCount * 1000) / (elapsed * 1024));

      if (this.elFps) {
        this.elFps.textContent = fps.toString();
      }
      if (this.elBytes) {
        this.elBytes.textContent = `${kbps} KB/s`;
      }

      this.frameCount = 0;
      this.bytesCount = 0;
      this.lastUpdate = now;
    }
  }

  /**
   * Reset all analytics to original values.
   */
  public reset() {
    this.frameCount = 0;
    this.bytesCount = 0;
    this.drops = 0;
    this.pingTimes.clear();
    this.rttHistory = [];
    
    if (this.elFps) this.elFps.textContent = '0';
    if (this.elRtt) this.elRtt.textContent = '0 ms';
    if (this.elBytes) this.elBytes.textContent = '0 KB/s';
    if (this.elDrops) this.elDrops.textContent = '0';
  }
}
