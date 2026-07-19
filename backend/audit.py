# backend/audit.py
import os
import json
import logging
import base64
import asyncio
import threading
from datetime import datetime, timezone
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

class AuditLogger:
    def __init__(self):
        # Place logs in backend/logs folder, or next to exe if running as frozen executable
        import sys
        if getattr(sys, "frozen", False):
            base_dir = os.path.dirname(sys.executable)
        else:
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.log_dir = os.path.join(base_dir, "logs")
        os.makedirs(self.log_dir, exist_ok=True)
        self.log_path = os.path.join(self.log_dir, "audit.log")
        self._lock = threading.Lock()

        # Load or generate 256-bit AES-GCM key
        key_env = os.getenv("AUDIT_LOG_KEY")
        if key_env:
            try:
                # Key can be passed as raw base64 string
                self.key = base64.b64decode(key_env)
                if len(self.key) != 32:
                    raise ValueError("Key must be exactly 32 bytes after base64 decoding.")
            except Exception as e:
                logger.error(f"Invalid AUDIT_LOG_KEY provided ({e}). Generating transient key.")
                self.key = AESGCM.generate_key(bit_length=256)
        else:
            logger.warning("AUDIT_LOG_KEY environment variable not set. Using transient encryption key.")
            self.key = AESGCM.generate_key(bit_length=256)

        self.aesgcm = AESGCM(self.key)

    async def log_event(self, event_type: str, details: dict) -> None:
        """Encrypts event details and logs to the audit file asynchronously."""
        event = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "event_type": event_type,
            "details": details
        }
        try:
            data = json.dumps(event).encode("utf-8")
            nonce = os.urandom(12)
            ciphertext = self.aesgcm.encrypt(nonce, data, None)

            # Format: base64(nonce) + ":" + base64(ciphertext)
            encoded_nonce = base64.b64encode(nonce).decode("utf-8")
            encoded_cipher = base64.b64encode(ciphertext).decode("utf-8")

            await asyncio.to_thread(self._write_log, encoded_nonce, encoded_cipher)
        except Exception as e:
            logger.error(f"Audit log encryption failed: {e}")

    def _write_log(self, encoded_nonce: str, encoded_cipher: str) -> None:
        with self._lock:
            with open(self.log_path, "a") as f:
                f.write(f"{encoded_nonce}:{encoded_cipher}\n")

    async def get_decrypted_events(self, limit: int = 50) -> list:
        """Reads, decrypts, and returns the latest audit log events."""
        if not os.path.exists(self.log_path):
            return []

        def _read_and_decrypt():
            events = []
            with self._lock:
                try:
                    with open(self.log_path, "r") as f:
                        lines = f.readlines()
                except Exception as e:
                    logger.error(f"Failed to read audit log file: {e}")
                    return []

            for line in reversed(lines):
                line = line.strip()
                if not line or ":" not in line:
                    continue
                try:
                    parts = line.split(":", 1)
                    if len(parts) != 2:
                        continue
                    encoded_nonce, encoded_cipher = parts
                    nonce = base64.b64decode(encoded_nonce)
                    ciphertext = base64.b64decode(encoded_cipher)

                    data = self.aesgcm.decrypt(nonce, ciphertext, None)
                    event = json.loads(data.decode("utf-8"))
                    events.append(event)
                    if len(events) >= limit:
                        break
                except Exception:
                    # Skip decryption errors (e.g. key mismatch after service restarts)
                    continue
            return events

        return await asyncio.to_thread(_read_and_decrypt)
