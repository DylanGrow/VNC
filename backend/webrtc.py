import os
import asyncio

logger = logging.getLogger(__name__)

try:
    import aiortc
    from aiortc import RTCPeerConnection, RTCSessionDescription
    webrtc_available = True
except ImportError:
    webrtc_available = False

class WebRTCSessionManager:
    def __init__(self):
        self.available = webrtc_available
        self.pcs = set()
        if self.available:
            min_port = int(os.getenv("WEBRTC_MIN_PORT", "10000"))
            max_port = int(os.getenv("WEBRTC_MAX_PORT", "10100"))
            try:
                self.patch_ports(min_port, max_port)
                logger.info(f"WebRTC: Port bounds restricted to {min_port}-{max_port}")
            except Exception as e:
                logger.error(f"Failed to patch WebRTC ports: {e}")
        else:
            logger.info("aiortc library not found. WebRTC streaming disabled (falling back to WebSocket).")

    def patch_ports(self, min_port: int, max_port: int) -> None:
        """Monkey patches asyncio's create_datagram_endpoint to bound UDP candidate ports."""
        original_create_datagram_endpoint = asyncio.AbstractEventLoop.create_datagram_endpoint

        async def patched_create_datagram_endpoint(loop_self, protocol_factory, local_addr=None, *args, **kwargs):
            if local_addr and isinstance(local_addr, tuple) and len(local_addr) >= 2:
                host, port = local_addr[0], local_addr[1]
                if port == 0:
                    import random
                    ports = list(range(min_port, max_port + 1))
                    random.shuffle(ports)
                    for attempt_port in ports:
                        try:
                            new_local_addr = (host, attempt_port) + local_addr[2:]
                            return await original_create_datagram_endpoint(
                                loop_self, protocol_factory, new_local_addr, *args, **kwargs
                            )
                        except OSError:
                            continue
                    logger.warning(f"All ports in WebRTC range {min_port}-{max_port} are in use. Falling back to dynamic allocation.")
            return await original_create_datagram_endpoint(loop_self, protocol_factory, local_addr, *args, **kwargs)

        asyncio.AbstractEventLoop.create_datagram_endpoint = patched_create_datagram_endpoint

    async def handle_offer(self, offer_sdp: str, offer_type: str) -> dict:
        """Handles incoming WebRTC offer and returns generated session description answer."""
        if not self.available:
            return {"status": "unsupported", "detail": "WebRTC is not available on this host."}
            
        try:
            pc = RTCPeerConnection()
            self.pcs.add(pc)
            
            @pc.on("connectionstatechange")
            async def on_connectionstatechange():
                logger.info(f"WebRTC Connection State: {pc.connectionState}")
                if pc.connectionState in ["failed", "closed"]:
                    self.pcs.discard(pc)
                    
            offer = RTCSessionDescription(sdp=offer_sdp, type=offer_type)
            await pc.setRemoteDescription(offer)
            
            # Generate local answer SDP
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            
            return {
                "status": "success",
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type
            }
        except Exception as e:
            logger.error(f"Error negotiating WebRTC connection: {e}")
            return {"status": "error", "detail": str(e)}

    def cleanup(self):
        """Asynchronously closes all active peer connections."""
        if not self.available:
            return
        import asyncio
        for pc in list(self.pcs):
            try:
                coro = pc.close()
                asyncio.create_task(coro)
            except Exception as e:
                logger.debug(f"Failed to close WebRTC peer connection: {e}")
        self.pcs.clear()
