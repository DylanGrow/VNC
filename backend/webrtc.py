# backend/webrtc.py
import logging

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
        if not self.available:
            logger.info("aiortc library not found. WebRTC streaming disabled (falling back to WebSocket).")

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
