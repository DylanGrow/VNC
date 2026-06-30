# backend/metrics.py
import time
import threading
import psutil

class MetricsCollector:
    def __init__(self):
        self.start_time = time.time()
        self.total_frames = 0
        self.total_inputs = 0
        self.bytes_sent = 0
        self.rolling_transfers = [] # List of (timestamp, size_bytes)
        self.lock = threading.Lock()

    def get_uptime(self) -> float:
        """Return the uptime of the server in seconds."""
        return time.time() - self.start_time

    def log_frame(self, size_bytes: int) -> None:
        """Record a screen frame capture transmission."""
        with self.lock:
            self.total_frames += 1
            self.bytes_sent += size_bytes
            self.rolling_transfers.append((time.time(), size_bytes))
            self._prune_rolling_transfers_unlocked()

    def _prune_rolling_transfers_unlocked(self) -> None:
        now = time.time()
        self.rolling_transfers = [item for item in self.rolling_transfers if now - item[0] <= 5.0]

    def get_rolling_bandwidth_kbs(self) -> float:
        """Calculate the rolling bandwidth in KB/s over the last 5 seconds."""
        with self.lock:
            self._prune_rolling_transfers_unlocked()
            if not self.rolling_transfers:
                return 0.0
            total_bytes = sum(item[1] for item in self.rolling_transfers)
            return (total_bytes / 1024.0) / 5.0

    def log_input(self, input_type: str) -> None:
        """Record an incoming mouse or keyboard action."""
        with self.lock:
            self.total_inputs += 1

    def get_memory_usage(self) -> float:
        """Return memory consumption of the Python process in MB."""
        try:
            process = psutil.Process()
            return process.memory_info().rss / (1024 * 1024)
        except Exception:
            return 0.0
