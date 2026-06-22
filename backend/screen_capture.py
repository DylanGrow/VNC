# backend/screen_capture.py
import mss
import io
from PIL import Image, ImageDraw
import base64
import logging
import hashlib
import math
import time
import threading
from typing import List, Dict, Tuple, Optional

logger = logging.getLogger(__name__)

class ScreenCapture:
    def __init__(self):
        self.lock = threading.Lock()
        self.sct = None
        self.headless = False
        
        # Test initial connection
        self._get_sct()
            
        self.prev_hashes: Dict[int, str] = {}
        # Stores historical hashes of quadrants per monitor {monitor_id: {quad_index: hash}}
        self.quadrant_hashes: Dict[int, Dict[int, str]] = {}

    def _get_sct(self) -> Optional[mss.mss]:
        """Returns the active mss connection, attempting to restore it if closed or broken."""
        if self.headless:
            return None
        with self.lock:
            if self.sct is None:
                try:
                    self.sct = mss.mss()
                    # Verify handle validity by querying monitors
                    _ = self.sct.monitors
                    self.headless = False
                except Exception as e:
                    logger.warning(f"Failed to initialize mss connection handle: {e}")
                    self.sct = None
                    # Fallback to headless only if it consistently fails
                    self.headless = True
            return self.sct

    def get_monitors(self) -> List[Dict]:
        """Get list of available monitors"""
        sct = self._get_sct()
        if not sct:
            return [{
                "id": 1,
                "width": 1280,
                "height": 720,
                "left": 0,
                "top": 0,
                "is_primary": True
            }]
            
        try:
            with self.lock:
                monitors_list = sct.monitors
            monitors = []
            for i, mon in enumerate(monitors_list[1:], 1):
                monitors.append({
                    "id": i,
                    "width": mon["width"],
                    "height": mon["height"],
                    "left": mon["left"],
                    "top": mon["top"],
                    "is_primary": i == 1
                })
            if not monitors:
                monitors.append({
                    "id": 1,
                    "width": 1280,
                    "height": 720,
                    "left": 0,
                    "top": 0,
                    "is_primary": True
                })
            return monitors
        except Exception as e:
            logger.debug(f"Failed to fetch monitors via mss: {e}. Resetting handle.")
            with self.lock:
                if self.sct:
                    try:
                        self.sct.close()
                    except Exception:
                        pass
                    self.sct = None
            return [{
                "id": 1,
                "width": 1280,
                "height": 720,
                "left": 0,
                "top": 0,
                "is_primary": True
            }]

    def adjust_display_resolution(self, monitor_id: int, width: int, height: int) -> bool:
        """Attempts to dynamically resize host display resolution (Linux xrandr command)."""
        if self.headless:
            return False
        try:
            import subprocess
            output_check = subprocess.run(["xrandr"], capture_output=True, text=True, check=False)
            if output_check.returncode == 0:
                for line in output_check.stdout.splitlines():
                    if " connected" in line:
                        display_name = line.split()[0]
                        cmd = ["xrandr", "--output", display_name, "--mode", f"{width}x{height}"]
                        subprocess.run(cmd, capture_output=True, check=False)
                        logger.info(f"Display {display_name} resolution updated to {width}x{height}")
                        return True
            return False
        except Exception as e:
            logger.debug(f"Failed to adjust host display resolution: {e}")
            return False

    def capture(self, monitor_id: int = 1, quality: int = 75, 
                resolution: Optional[Tuple[int, int]] = (1280, 720),
                force_full: bool = False) -> Tuple[Optional[str], bool, int, int, int, int, bool]:
        """
        Capture screen and encode to base64 JPEG.
        Supports 2x2 quadrant delta tiles comparison.
        Returns:
            Tuple[base64_jpeg_string, has_changed, x, y, width, height, is_delta]
        """
        sct = self._get_sct()
        if not sct:
            mock_data, changed = self._generate_mock_frame(resolution)
            w, h = resolution if resolution else (1280, 720)
            return mock_data, changed, 0, 0, w, h, False

        try:
            with self.lock:
                monitors = sct.monitors
                if not monitors or len(monitors) <= 1:
                    mock_data, changed = self._generate_mock_frame(resolution)
                    w, h = resolution if resolution else (1280, 720)
                    return mock_data, changed, 0, 0, w, h, False

                # Ensure monitor index is valid
                if monitor_id < 1 or monitor_id >= len(monitors):
                    monitor_id = 1
                
                monitor = monitors[monitor_id]
                screenshot = sct.grab(monitor)
            
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
            
            if resolution and (img.width != resolution[0] or img.height != resolution[1]):
                img = img.resize(resolution, Image.Resampling.LANCZOS)

            w, h = img.width, img.height

            # Partition into 2x2 grid quadrants
            half_w, half_h = w // 2, h // 2
            quadrants = [
                (0, 0, half_w, half_h),           # Q0: Top-Left
                (half_w, 0, w, half_h),           # Q1: Top-Right
                (0, half_h, half_w, h),           # Q2: Bottom-Left
                (half_w, half_h, w, h)            # Q3: Bottom-Right
            ]

            if monitor_id not in self.quadrant_hashes:
                self.quadrant_hashes[monitor_id] = {}

            changed_quads = []
            current_quad_hashes = {}

            # Calculate and compare MD5 hashes for each quadrant
            for idx, box in enumerate(quadrants):
                q_img = img.crop(box)
                diff_q = q_img.resize((16, 9), Image.Resampling.NEAREST)
                q_hash = hashlib.md5(diff_q.tobytes()).hexdigest()
                current_quad_hashes[idx] = q_hash

                old_hash = self.quadrant_hashes[monitor_id].get(idx)
                if old_hash != q_hash:
                    changed_quads.append((idx, box, q_img))

            # Case A: Screen is completely identical, no changes
            if len(changed_quads) == 0 and not force_full:
                return None, False, 0, 0, w, h, False

            # Case B: Significant changes (>2 quadrants modified) or full-frame override
            if force_full or len(changed_quads) > 2 or not self.quadrant_hashes[monitor_id]:
                # Update all quadrant hashes
                self.quadrant_hashes[monitor_id] = current_quad_hashes
                
                buffer = io.BytesIO()
                img.save(buffer, format="JPEG", quality=quality, optimize=True)
                jpeg_bytes = buffer.getvalue()
                base64_str = base64.b64encode(jpeg_bytes).decode("utf-8")
                return base64_str, True, 0, 0, w, h, False

            # Case C: Minor quadrant updates (send only the first modified quadrant to keep payload light)
            q_idx, box, q_img = changed_quads[0]
            self.quadrant_hashes[monitor_id][q_idx] = current_quad_hashes[q_idx]

            buffer = io.BytesIO()
            q_img.save(buffer, format="JPEG", quality=quality, optimize=True)
            jpeg_bytes = buffer.getvalue()
            base64_str = base64.b64encode(jpeg_bytes).decode("utf-8")

            tx, ty = box[0], box[1]
            tw, th = box[2] - box[0], box[3] - box[1]
            return base64_str, True, tx, ty, tw, th, True

        except Exception as e:
            logger.error(f"Failed to capture screen: {e}. Resetting mss handle.")
            with self.lock:
                if self.sct:
                    try:
                        self.sct.close()
                    except Exception:
                        pass
                    self.sct = None
            mock_data, changed = self._generate_mock_frame(resolution)
            w, h = resolution if resolution else (1280, 720)
            return mock_data, changed, 0, 0, w, h, False

    def capture_pil(self, monitor_id: int = 1, resolution: Optional[Tuple[int, int]] = (1280, 720)):
        """Capture screen and return as PIL Image object."""
        sct = self._get_sct()
        if not sct:
            return None
        try:
            with self.lock:
                monitors = sct.monitors
                if not monitors or len(monitors) <= 1:
                    return None
                if monitor_id < 1 or monitor_id >= len(monitors):
                    monitor_id = 1
                monitor = monitors[monitor_id]
                screenshot = sct.grab(monitor)
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
            if resolution and (img.width != resolution[0] or img.height != resolution[1]):
                img = img.resize(resolution, Image.Resampling.LANCZOS)
            return img
        except Exception as e:
            logger.debug(f"Failed to capture PIL image: {e}. Resetting handle.")
            with self.lock:
                if self.sct:
                    try:
                        self.sct.close()
                    except Exception:
                        pass
                    self.sct = None
            return None

    def _generate_mock_frame(self, resolution: Optional[Tuple[int, int]]) -> Tuple[str, bool]:
        """Generates a dynamic visual frame for headless/test environments"""
        w, h = resolution if resolution else (1280, 720)
        img = Image.new("RGB", (w, h), color=(15, 23, 42))  # Slate-900 theme color
        draw = ImageDraw.Draw(img)
        
        t = time.time()
        cx = int((w / 2) + (w / 4) * math.sin(t * 2))
        cy = int((h / 2) + (h / 5) * math.cos(t * 3))
        
        # Grid lines
        for x in range(0, w, 80):
            draw.line([(x, 0), (x, h)], fill=(30, 41, 59), width=1)
        for y in range(0, h, 80):
            draw.line([(0, y), (w, y)], fill=(30, 41, 59), width=1)

        # Dynamic circle (moving target)
        draw.ellipse([cx - 25, cy - 25, cx + 25, cy + 25], fill=(99, 102, 241), outline=(129, 140, 248), width=3) # indigo-500
        
        # Text details
        current_time = time.strftime("%H:%M:%S") + f".{int((t % 1) * 100):02d}"
        msg = f"VNC System (Mock Mode)\nTime: {current_time}\nMonitor ID: 1\nResolution: {w}x{h}"
        draw.text((w // 2 - 100, h // 2 - 30), msg, fill=(241, 245, 249))

        # Check hash of movement to see if we send
        frame_hash = f"{int(cx)},{int(cy)}"
        if self.prev_hashes.get(-1) == frame_hash:
            return None, False
        self.prev_hashes[-1] = frame_hash

        buffer = io.BytesIO()
        img.save(buffer, format="JPEG", quality=60)
        jpeg_bytes = buffer.getvalue()
        base64_str = base64.b64encode(jpeg_bytes).decode("utf-8")
        return base64_str, True
