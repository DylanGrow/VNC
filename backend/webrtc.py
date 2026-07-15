# backend/webrtc.py
import os
import asyncio
import logging
import threading

logger = logging.getLogger(__name__)

try:
    import importlib.util
    if importlib.util.find_spec("aiortc") is None or importlib.util.find_spec("av") is None:
        raise ImportError()
    from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack, AudioStreamTrack
    from av import VideoFrame, AudioFrame
    webrtc_available = True
except ImportError:
    webrtc_available = False
    # Stub base classes to avoid compilation crashes on missing dependencies
    class VideoStreamTrack:
        pass
    class AudioStreamTrack:
        pass

if webrtc_available:
    class ScreenVideoCaptureTrack(VideoStreamTrack):
        def __init__(self, screen_capture, monitor_id=1, fps=30):
            super().__init__()
            self.screen_capture = screen_capture
            self.monitor_id = monitor_id
            self.fps = fps
            self.target_delay = 1.0 / fps

        async def recv(self):
            pts, time_base = await self.next_timestamp()

            # Execute PIL grab in worker thread to prevent blocking ASGI event loop
            pil_img = await asyncio.to_thread(
                self.screen_capture.capture_pil,
                self.monitor_id,
                resolution=(1280, 720)
            )

            if not pil_img:
                # Yield a blank solid black fallback frame on capture error
                frame = VideoFrame(width=1280, height=720, format="rgb24")
                for plane in frame.planes:
                    plane.update(b"\x00" * plane.buffer_size)
            else:
                try:
                    frame = VideoFrame.from_image(pil_img)
                except Exception as e:
                    logger.debug(f"WebRTC VideoFrame conversion failed: {e}")
                    frame = VideoFrame(width=1280, height=720, format="rgb24")
                    for plane in frame.planes:
                        plane.update(b"\x00" * plane.buffer_size)
                finally:
                    pil_img.close()

            frame.pts = pts
            frame.time_base = time_base

            await asyncio.sleep(self.target_delay)
            return frame

    class LoopbackAudioCaptureTrack(AudioStreamTrack):
        def __init__(self, audio_capture):
            super().__init__()
            self.audio_capture = audio_capture
            self.buffer = bytearray()
            self.buffer_lock = threading.Lock()

        async def recv(self):
            pts, time_base = await self.next_timestamp()

            # At 44100 Hz, 20ms corresponds to 882 samples (16-bit mono = 2 bytes/sample)
            num_samples = int(self.audio_capture.sample_rate * 0.020)
            required_bytes = num_samples * 2

            # Check buffer length before fetching additional samples
            with self.buffer_lock:
                current_len = len(self.buffer)

            if current_len < required_bytes:
                chunk = await asyncio.to_thread(self.audio_capture.read_chunk, 20)
                if chunk:
                    with self.buffer_lock:
                        self.buffer.extend(chunk)

            frame_data = None
            with self.buffer_lock:
                if len(self.buffer) >= required_bytes:
                    frame_data = bytes(self.buffer[:required_bytes])
                    del self.buffer[:required_bytes]

            if not frame_data:
                # Yield mute silence frame
                frame = AudioFrame(format="s16", layout="mono", samples=num_samples)
                for plane in frame.planes:
                    plane.update(b"\x00" * plane.buffer_size)
            else:
                try:
                    frame = AudioFrame(format="s16", layout="mono", samples=num_samples)
                    frame.planes[0].update(frame_data)
                except Exception as e:
                    logger.debug(f"WebRTC AudioFrame conversion failed: {e}")
                    frame = AudioFrame(format="s16", layout="mono", samples=num_samples)
                    for plane in frame.planes:
                        plane.update(b"\x00" * plane.buffer_size)

            frame.pts = pts
            frame.time_base = time_base
            return frame

class WebRTCSessionManager:
    def __init__(self):
        self.available = webrtc_available
        self.pcs = {}  # Map conn_id -> RTCPeerConnection to prevent connection leaks
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

    async def handle_offer(self, offer_sdp: str, offer_type: str, screen_capture, audio_capture, conn_id: str) -> dict:
        """Handles incoming WebRTC offer and returns generated session description answer."""
        if not self.available:
            return {"status": "unsupported", "detail": "WebRTC is not available on this host."}

        try:
            # Safely replace existing session peer connection if negotiated again
            old_pc = self.pcs.pop(conn_id, None)
            if old_pc:
                asyncio.create_task(self._close_pc(old_pc))

            pc = RTCPeerConnection()
            self.pcs[conn_id] = pc
            # Store reference to clean up audio recorder on session termination
            pc.audio_capture = audio_capture

            @pc.on("connectionstatechange")
            async def on_connectionstatechange():
                logger.info(f"WebRTC Connection State for {conn_id}: {pc.connectionState}")
                if pc.connectionState in ["failed", "closed"]:
                    self.pcs.pop(conn_id, None)
                    asyncio.create_task(self._close_pc(pc))

            # Attach custom video and audio tracks
            video_track = ScreenVideoCaptureTrack(screen_capture, monitor_id=1)
            pc.addTrack(video_track)

            audio_track = LoopbackAudioCaptureTrack(audio_capture)
            pc.addTrack(audio_track)

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

    async def close_connection(self, conn_id: str):
        """Asynchronously closes a specific peer connection by its session ID."""
        pc = self.pcs.pop(conn_id, None)
        if pc:
            logger.info(f"WebRTC: Initiating close for session connection {conn_id}")
            await self._close_pc(pc)

    def cleanup(self):
        """Asynchronously closes all active peer connections and stops transceivers."""
        if not self.available:
            return
        import asyncio
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        for conn_id, pc in list(self.pcs.items()):
            try:
                coro = self._close_pc(pc)
                if loop and loop.is_running():
                    try:
                        loop.create_task(coro)
                    except RuntimeError:
                        asyncio.run_coroutine_threadsafe(coro, loop)
                else:
                    asyncio.run(coro)
            except Exception as e:
                logger.debug(f"Failed to initiate WebRTC close task: {e}")
        self.pcs.clear()

    async def _close_pc(self, pc) -> None:
        """Safely stops transceivers and closes peer connection."""
        try:
            audio_cap = getattr(pc, "audio_capture", None)
            if audio_cap:
                try:
                    audio_cap.cleanup()
                except Exception:
                    pass
                pc.audio_capture = None

            for transceiver in list(pc.getTransceivers()):
                try:
                    transceiver.stop()
                except Exception:
                    pass
            await pc.close()
            logger.info("WebRTC: PeerConnection cleanly destroyed.")
        except Exception as e:
            logger.debug(f"Error closing RTCPeerConnection: {e}")
