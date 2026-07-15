import sys
import logging
import threading
from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)

try:
    import pystray
    pystray_available = True
except ImportError:
    pystray_available = False

class SystemTrayApp:
    def __init__(self, disconnect_all_callback=None, input_lock_callback=None, exit_callback=None):
        self.disconnect_all = disconnect_all_callback
        self.input_lock = input_lock_callback
        self.exit_callback = exit_callback
        self.available = pystray_available
        self.icon = None
        self.input_locked = False
        
        if sys.platform == "darwin":
            logger.warning("System tray applet is disabled on macOS because pystray requires the main thread GUI loop.")
            self.available = False

        if not self.available and sys.platform != "darwin":
            logger.info("pystray library not found. System tray applet disabled.")

    def create_image(self, color1=(15, 23, 42), color2=(99, 102, 241)):
        # Generate a simple VNC icon (slate-900 with an indigo inner square)
        image = Image.new("RGB", (64, 64), color=color1)
        dc = ImageDraw.Draw(image)
        dc.rectangle([16, 16, 48, 48], fill=color2)
        return image

    def on_disconnect_all(self):
        logger.info("Tray applet: Triggered Disconnect All Operators override.")
        if self.disconnect_all:
            self.disconnect_all()

    def on_toggle_input_lock(self, icon, item):
        self.input_locked = not self.input_locked
        logger.info(f"Tray applet: Remote control input lock set to: {self.input_locked}")
        if self.input_lock:
            self.input_lock(self.input_locked)

    def on_exit(self, icon):
        logger.info("Tray applet: Requesting exit VNC server.")
        icon.stop()
        if self.exit_callback:
            try:
                self.exit_callback()
                return
            except Exception as e:
                logger.debug(f"Exit callback failed: {e}")

        import os
        import signal
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception as e:
            logger.debug(f"Failed to propagate exit signal: {e}")
            import sys
            sys.exit(0)

    def run(self):
        """Launches the system tray applet on a separate daemon thread."""
        if not self.available:
            return

        def setup_icon():
            try:
                menu = pystray.Menu(
                    pystray.MenuItem("Antigravity VNC Active", lambda: None, enabled=False),
                    pystray.MenuItem("Disconnect All Operators", self.on_disconnect_all),
                    pystray.MenuItem("Lock Remote Control", self.on_toggle_input_lock, checked=lambda item: self.input_locked),
                    pystray.MenuItem("Exit Server", self.on_exit)
                )
                self.icon = pystray.Icon(
                    name="AntigravityVNC",
                    icon=self.create_image(),
                    title="Antigravity VNC Server",
                    menu=menu
                )
                self.icon.run()
            except Exception as e:
                logger.debug(f"Failed to start system tray applet (probably running headlessly): {e}")

        t = threading.Thread(target=setup_icon, daemon=True)
        t.start()
