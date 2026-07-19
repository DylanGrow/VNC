export class Reconnector {
  private baseDelay: number;
  private maxDelay: number;
  private multiplier: number;
  private jitter: number;
  private attempts = 0;
  private timerId: number | null = null;

  constructor(baseDelay = 1000, maxDelay = 30000, multiplier = 2, jitter = 0.25) {
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.multiplier = multiplier;
    this.jitter = jitter;
  }

  public get isReconnecting(): boolean {
    return this.timerId !== null;
  }

  /**
   * Schedule a reconnection callback with calculated exponential delay and randomized jitter.
   */
  public scheduleReconnect(callback: () => void) {
    if (this.timerId !== null) {
      return;
    }

    this.attempts++;
    // Compute basic backoff
    let delay = this.baseDelay * Math.pow(this.multiplier, this.attempts - 1);
    delay = Math.min(delay, this.maxDelay);

    // Apply jitter ratio: [delay * (1 - jitter), delay * (1 + jitter)]
    const minJitter = 1 - this.jitter;
    const maxJitter = 1 + this.jitter;
    const jitterFactor = minJitter + Math.random() * (maxJitter - minJitter);
    const finalDelay = Math.round(delay * jitterFactor);

    console.warn(`[VNC Connection] Reconnecting (Attempt ${this.attempts}) in ${finalDelay}ms...`);

    this.timerId = window.setTimeout(() => {
      this.timerId = null;
      callback();
    }, finalDelay);
  }

  /**
   * Clear any pending reconnection timers and reset the attempt count.
   */
  public reset() {
    this.attempts = 0;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
  }
}
