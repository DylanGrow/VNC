# backend/audio.py
import logging
import time
import math
import struct
from typing import Optional

logger = logging.getLogger(__name__)

try:
    # Optional audio loopback libraries
    import soundcard as sc
    audio_capture_available = True
except ImportError:
    audio_capture_available = False

class AudioCapture:
    def __init__(self, sample_rate: int = 44100, channels: int = 1):
        self.sample_rate = sample_rate
        self.channels = channels
        self.available = audio_capture_available
        self.t = 0.0
        
        if not self.available:
            logger.info("soundcard library not found. Falling back to synth sine-wave audio generator.")

    def read_chunk(self, duration_ms: int = 100) -> bytes:
        """Reads a chunk of audio. Falls back to generating a sine wave if library is missing or fails."""
        num_samples = int(self.sample_rate * (duration_ms / 1000.0))
        
        if not self.available:
            # Generate a 440Hz sine wave (A4 note) in 16-bit PCM mono format
            frequency = 440.0
            amplitude = 32767 * 0.15  # 15% volume
            buf = bytearray()
            
            for _ in range(num_samples):
                val = int(amplitude * math.sin(2 * math.pi * frequency * self.t))
                buf.extend(struct.pack("<h", val))
                self.t += 1.0 / self.sample_rate
                if self.t > 1.0:
                    self.t -= 1.0
            return bytes(buf)
            
        try:
            # Try capturing desktop speakers via loopback device
            speaker = sc.default_speaker()
            mic = sc.get_microphone(id=speaker.id, include_loopback=True)
            with mic.recorder(samplerate=self.sample_rate, channels=self.channels) as recorder:
                data = recorder.record(numsamples=num_samples)
                # Convert float32 frames [-1.0, 1.0] to 16-bit PCM bytes
                buf = bytearray()
                for val in data.flatten():
                    int_val = int(max(-1.0, min(1.0, val)) * 32767)
                    buf.extend(struct.pack("<h", int_val))
                return bytes(buf)
        except Exception as e:
            logger.debug(f"Native audio capture failed: {e}. Falling back to silent PCM.")
            return b"\x00" * (num_samples * 2)
