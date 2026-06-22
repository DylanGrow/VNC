# backend/metrics.py
import time
import psutil

class MetricsCollector:
    def __init__(self):
        self.start_time = time.time()
        self.total_frames = 0
        self.total_inputs = 0
        self.bytes_sent = 0

    def get_uptime(self) -> float:
        """Return the uptime of the server in seconds."""
        return time.time() - self.start_time

    def log_frame(self, size_bytes: int) -> None:
        """Record a screen frame capture transmission."""
        self.total_frames += 1
        self.bytes_sent += size_bytes

    def log_input(self, input_type: str) -> None:
        """Record an incoming mouse or keyboard action."""
        self.total_inputs += 1

    def get_memory_usage(self) -> float:
        """Return memory consumption of the Python process in MB."""
        try:
            process = psutil.Process()
            return process.memory_info().rss / (1024 * 1024)
        except Exception:
            return 0.0
