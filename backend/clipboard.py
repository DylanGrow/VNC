# backend/clipboard.py
import logging
from typing import Optional

try:
    import pyperclip
    pyperclip_available = True
except ImportError:
    pyperclip_available = False

logger = logging.getLogger(__name__)

class ClipboardManager:
    def __init__(self, max_length: int = 102400):  # 100 KB safety limit
        self.max_length = max_length
        self.mock_clipboard = ""
        self.available = pyperclip_available
        
        if not self.available:
            logger.warning("pyperclip library not found. Falling back to in-memory clipboard emulation.")

    def get_text(self) -> str:
        """Fetch text from system clipboard with fallback to in-memory store."""
        if not self.available:
            return self.mock_clipboard
            
        try:
            text = pyperclip.paste()
            if not text:
                return ""
            if len(text) > self.max_length:
                logger.warning(f"System clipboard size ({len(text)}) exceeds threshold. Truncating.")
                text = text[:self.max_length]
            return text
        except Exception as e:
            logger.debug(f"Failed to access host clipboard: {e}. Falling back to in-memory store.")
            return self.mock_clipboard

    def set_text(self, text: Optional[str] = None) -> None:
        """Set text in system clipboard with fallback to in-memory store."""
        # Sanitize string: retain only printables, tabs, newlines, and carriage returns
        raw_str = str(text) if text is not None else ""
        text_str = "".join(ch for ch in raw_str if ch.isprintable() or ch in "\n\r\t")
        
        if len(text_str) > self.max_length:
            logger.warning(f"Clipboard update length ({len(text_str)}) exceeds maximum allowed size. Truncating.")
            text_str = text_str[:self.max_length]

        if not self.available:
            self.mock_clipboard = text_str
            return

        try:
            pyperclip.copy(text_str)
            logger.info("Host clipboard synchronized successfully.")
        except Exception as e:
            logger.warning(f"Failed to update host clipboard: {e}. Falling back to in-memory store.")
            self.mock_clipboard = text_str
