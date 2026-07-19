# backend/rate_limit.py
import logging
import psutil
from collections import defaultdict

import threading

logger = logging.getLogger(__name__)

class ConnectionManager:
    def __init__(self, max_per_ip: int = 3, max_global: int = 10, max_memory_percent: float = 90.0):
        # Map client_ip -> set of connection/socket IDs
        self.active_connections = defaultdict(set)
        self.max_per_ip = max_per_ip
        self.max_global = max_global
        self.max_memory_percent = max_memory_percent
        self.lock = threading.Lock()

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

        with self.lock:
            # Global connection limit
            total_connections = sum(len(conns) for conns in self.active_connections.values())
            if total_connections >= self.max_global:
                logger.warning(f"Rejected connection from {client_ip}: Global limit of {self.max_global} reached")
                return False

            # Per-IP connection limit
            ip_connections = len(self.active_connections[client_ip]) if client_ip in self.active_connections else 0
            if ip_connections >= self.max_per_ip:
                logger.warning(f"Rejected connection from {client_ip}: Per-IP limit of {self.max_per_ip} reached")
                return False

            self.active_connections[client_ip].add(conn_id)
            logger.info(f"Connection {conn_id} accepted from {client_ip}. IP Active: {len(self.active_connections[client_ip])}, Total Active: {total_connections + 1}")
            return True

    def remove_connection(self, client_ip: str, conn_id: str):
        """Deregister an active connection when it closes."""
        with self.lock:
            if client_ip in self.active_connections:
                self.active_connections[client_ip].discard(conn_id)
                if not self.active_connections[client_ip]:
                    del self.active_connections[client_ip]
        logger.info(f"Connection {conn_id} removed for {client_ip}")

    def count_connections(self) -> int:
        """Count total active connections."""
        with self.lock:
            return sum(len(conns) for conns in self.active_connections.values())

    def get_memory_usage(self) -> float:
        """Get current memory usage of this process in MB."""
        try:
            process = psutil.Process()
            return process.memory_info().rss / (1024 * 1024)
        except Exception:
            return 0.0

    def cleanup_stale_connections(self, active_conn_ids: set) -> None:
        """Purges any registered connections that are not present in the active websocket ID set."""
        with self.lock:
            for client_ip, conns in list(self.active_connections.items()):
                stale = [c for c in conns if c not in active_conn_ids]
                for c in stale:
                    conns.discard(c)
                    logger.info(f"Cleanup: Pruned stale connection {c} from IP {client_ip}")
                if not conns:
                    del self.active_connections[client_ip]
