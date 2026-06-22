# backend/rate_limit.py
import logging
import psutil
from collections import defaultdict

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self, max_per_ip: int = 3, max_global: int = 10, max_memory_percent: float = 90.0):
        # Map client_ip -> set of connection/socket IDs
        self.active_connections = defaultdict(set)
        self.max_per_ip = max_per_ip
        self.max_global = max_global
        self.max_memory_percent = max_memory_percent

    def add_connection(self, client_ip: str, conn_id: str) -> bool:
        """
        Register a new active connection.
        Returns True if allowed, False if rejected due to limits or memory exhaustion.
        """
        # Memory safeguarding
        mem = psutil.virtual_memory()
        if mem.percent >= self.max_memory_percent:
            logger.error(f"Rejected connection from {client_ip}: Server memory critical ({mem.percent}%)")
            return False

        # Global connection limit
        total_connections = self.count_connections()
        if total_connections >= self.max_global:
            logger.warning(f"Rejected connection from {client_ip}: Global limit of {self.max_global} reached")
            return False

        # Per-IP connection limit
        ip_connections = len(self.active_connections[client_ip])
        if ip_connections >= self.max_per_ip:
            logger.warning(f"Rejected connection from {client_ip}: Per-IP limit of {self.max_per_ip} reached")
            return False

        self.active_connections[client_ip].add(conn_id)
        logger.info(f"Connection {conn_id} accepted from {client_ip}. IP Active: {len(self.active_connections[client_ip])}, Total Active: {total_connections + 1}")
        return True

    def remove_connection(self, client_ip: str, conn_id: str):
        """Deregister an active connection when it closes."""
        if client_ip in self.active_connections:
            self.active_connections[client_ip].discard(conn_id)
            if not self.active_connections[client_ip]:
                del self.active_connections[client_ip]
        logger.info(f"Connection {conn_id} removed for {client_ip}")

    def count_connections(self) -> int:
        """Count total active connections."""
        return sum(len(conns) for conns in self.active_connections.values())

    def get_memory_usage(self) -> float:
        """Get current memory usage of this process in MB."""
        try:
            process = psutil.Process()
            return process.memory_info().rss / (1024 * 1024)
        except Exception:
            return 0.0
