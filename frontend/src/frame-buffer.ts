export interface FrameData {
  image: HTMLImageElement;
  x: number;
  y: number;
  w?: number;
  h?: number;
  isDelta: boolean;
}

export class FrameBuffer {
  private buffer = new Map<number, FrameData>();
  private nextExpectedSequence = 0;

  /**
   * Register a fully decoded image into the sequencing queue.
   * If it matches the next expected frame sequence, flushes it and all contiguous frames.
   */
  public addFrame(
    sequence: number,
    frame: FrameData,
    onReadyToRender: (frame: FrameData) => void,
    onDiscard: (frame: FrameData) => void
  ) {
    // Discard outdated frames
    if (sequence < this.nextExpectedSequence) {
      onDiscard(frame);
      return;
    }

    this.buffer.set(sequence, frame);
    this.flush(onReadyToRender);
  }

  /**
   * Sequentially flushes all buffered frames that are in sequence.
   */
  private flush(onReadyToRender: (frame: FrameData) => void) {
    while (this.buffer.has(this.nextExpectedSequence)) {
      const nextFrame = this.buffer.get(this.nextExpectedSequence);
      if (nextFrame) {
        onReadyToRender(nextFrame);
      }
      this.buffer.delete(this.nextExpectedSequence);
      this.nextExpectedSequence++;
    }
  }

  /**
   * Reset sequence keys and clear buffered memory.
   */
  public clear(onDiscard?: (frame: FrameData) => void) {
    if (onDiscard) {
      for (const frame of this.buffer.values()) {
        onDiscard(frame);
      }
    }
    this.buffer.clear();
    this.nextExpectedSequence = 0;
  }
}
