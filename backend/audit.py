# backend/audit.py
import os
import json
import logging
import base64
from datetime import datetime, timezone
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

class AuditLogger:
    def __init__(self):
        # Place logs in backend/logs folder
        self.log_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
        os.makedirs(self.log_dir, exist_ok=True)
        self.log_path = os.path.join(self.log_dir, "audit.log")
        
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

    def log_event(self, event_type: str, details: dict) -> None:
        """Encrypts event details and logs to the audit file."""
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
            
            with open(self.log_path, "a") as f:
                f.write(f"{encoded_nonce}:{encoded_cipher}\n")
        except Exception as e:
            logger.error(f"Audit log encryption failed: {e}")
