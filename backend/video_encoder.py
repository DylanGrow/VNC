# backend/video_encoder.py
import logging
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import av
    av_available = True
except ImportError:
    av_available = False

class VideoEncoder:
    def __init__(self, width: int = 1280, height: int = 720, fps: int = 30):
        self.width = width
        self.height = height
        self.fps = fps
        self.available = av_available
        self.container = None
        self.stream = None
        self.output_buffer = None
        
        if not self.available:
            logger.info("PyAV (av) library not found. H.264 video stream encoding disabled (falling back to JPEG tiles).")

    def encode_frame(self, pil_image) -> Optional[bytes]:
        """Encodes a PIL Image to H.264 video frame bytes if PyAV is available."""
        if not self.available:
            return None
            
        try:
            import io
            
            # Handle dynamic resolution changes on the fly
            if pil_image.width != self.width or pil_image.height != self.height:
                logger.info(f"H.264 Encoder: Resolution change detected ({self.width}x{self.height} -> {pil_image.width}x{pil_image.height}). Reinitializing container.")
                self.cleanup()
                self.width = pil_image.width
                self.height = pil_image.height

            if self.container is None:
                self.output_buffer = io.BytesIO()
                # Open an in-memory stream for h264 raw packets
                self.container = av.open(self.output_buffer, mode="w", format="h264")
                self.stream = self.container.add_stream("h264", rate=self.fps)
                self.stream.width = self.width
                self.stream.height = self.height
                self.stream.pix_fmt = "yuv420p"
                self.stream.options = {
                    "preset": "ultrafast",
                    "tune": "zerolatency",
                    "crf": "28"
                }

            # Map PIL Image directly into a PyAV VideoFrame
            frame = av.VideoFrame.from_image(pil_image)
            frame.pts = None
            
            for packet in self.stream.encode(frame):
                self.container.mux(packet)
                
            self.output_buffer.seek(0)
            data = self.output_buffer.read()
            self.output_buffer.seek(0)
            self.output_buffer.truncate(0)
            
            return data if data else None
        except Exception as e:
            logger.debug(f"Failed to encode screen frame to video H.264: {e}")
            return None

    def cleanup(self):
        """Flush and close PyAV stream buffers."""
        if self.container is not None:
            try:
                for packet in self.stream.encode():
                    pass
            except Exception:
                pass
            try:
                self.container.close()
            except Exception:
                pass
            self.container = None
            self.stream = None
            self.output_buffer = None
