# backend/main.py
from fastapi import FastAPI, WebSocket, HTTPException, Request, Depends, status, UploadFile, File
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import json
import logging
import asyncio
from datetime import datetime, timezone
import uuid
import os
import sys
import secrets
import time
import signal

import ipaddress
from auth import issue_token, verify_token, verify_token_string, TokenData, track_failed_attempt, is_ip_banned, clear_failed_attempts
from rate_limit import ConnectionManager
from screen_capture import ScreenCapture
from input_handler import InputValidator
from metrics import MetricsCollector
from clipboard import ClipboardManager
from audit import AuditLogger
from audio import AudioCapture
from tray import SystemTrayApp
from webrtc import WebRTCSessionManager

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(title="Antigravity VNC Server", version="1.0.0")

# Load environment configuration variables
SECURE_PASSWORD = os.getenv("SECURE_PASSWORD", "")
if not SECURE_PASSWORD:
    _env_mode = os.getenv("ENV", "development").lower()
    if _env_mode == "production":
        import sys
        logger.critical("SECURE_PASSWORD environment variable is not set. Refusing to start in production mode.")
        sys.exit(1)
    else:
        SECURE_PASSWORD = "dev_password_change_me"
        logger.warning("SECURE_PASSWORD not set. Using insecure default — do NOT use in production.")

MAX_UPLOAD_SIZE_MB = int(os.getenv("MAX_UPLOAD_SIZE_MB", "100"))
MAX_PER_IP = int(os.getenv("MAX_CONNECTIONS_PER_IP", "3"))
MAX_GLOBAL = int(os.getenv("MAX_GLOBAL_CONNECTIONS", "10"))

# Allowed CORS origins from env (comma-separated), fallback to localhost only
_allowed_origins_env = os.getenv("ALLOWED_ORIGINS", "")
ALLOWED_ORIGIN_LIST: list[str] = [
    o.strip() for o in _allowed_origins_env.split(",") if o.strip()
] if _allowed_origins_env else []

# Initialize system resources
connection_manager = ConnectionManager(max_per_ip=MAX_PER_IP, max_global=MAX_GLOBAL)
screen_capture = ScreenCapture()
input_validator = InputValidator()

# Android screen share publishing globals
ANDROID_SCREEN_STREAM = None
ANDROID_STREAM_LOCK = asyncio.Lock()
metrics_collector = MetricsCollector()
clipboard_manager = ClipboardManager()
audit_logger = AuditLogger()
webrtc_manager = WebRTCSessionManager()
LAST_INPUT_TIME = 0.0
ACTIVE_WEBSOCKETS = {}
ACTIVE_WEBSOCKET_LOCKS = {}
REMOTE_INPUT_LOCKED = False
EVENT_LOOP = None

def disconnect_all_operators():
    logger.info("System Tray: Disconnecting all remote operators...")
    global EVENT_LOOP
    if EVENT_LOOP is None:
        logger.warning("System Tray: Main event loop is not registered yet.")
        return

    def close_all():
        for conn_id, ws in list(ACTIVE_WEBSOCKETS.items()):
            try:
                asyncio.create_task(
                    ws.close(code=status.WS_1001_GOING_AWAY, reason="Session terminated by server admin")
                )
            except Exception as e:
                logger.debug(f"Failed to force close socket: {e}")

    EVENT_LOOP.call_soon_threadsafe(close_all)

def set_remote_input_lock(locked: bool):
    global REMOTE_INPUT_LOCKED
    REMOTE_INPUT_LOCKED = locked

SYSTEM_TRAY = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global SYSTEM_TRAY, EVENT_LOOP
    EVENT_LOOP = asyncio.get_running_loop()

    # Graceful IPC signal traps
    original_sigint = signal.getsignal(signal.SIGINT)
    original_sigterm = signal.getsignal(signal.SIGTERM)

    def handle_signal(sig, frame):
        logger.info(f"Signal {sig} received. Commencing pre-exit graceful cleanup...")

        # 1. Stop active WebRTC connections
        try:
            webrtc_manager.cleanup()
        except Exception as e:
            logger.debug(f"WebRTC cleanup on signal failed: {e}")

        # 1.5. Release screen capture display handles
        try:
            screen_capture.close()
        except Exception as e:
            logger.debug(f"Screen capture close on signal failed: {e}")

        # 2. Release modifier keys
        try:
            import pyautogui
            for key in ["ctrl", "shift", "alt", "win"]:
                pyautogui.keyUp(key)
        except Exception as e:
            logger.debug(f"pyautogui keyup on signal failed: {e}")

        # 3. Stop system tray
        global SYSTEM_TRAY
        if SYSTEM_TRAY and SYSTEM_TRAY.icon:
            try:
                SYSTEM_TRAY.icon.stop()
            except Exception:
                pass

        # 4. Disconnect all operator connections
        disconnect_all_operators()

        # Forward to original handler to allow uvicorn's server loop to finalize
        if sig == signal.SIGINT and callable(original_sigint):
            original_sigint(sig, frame)
        elif sig == signal.SIGTERM and callable(original_sigterm):
            original_sigterm(sig, frame)
        else:
            import sys
            sys.exit(0)

    try:
        signal.signal(signal.SIGINT, handle_signal)
        signal.signal(signal.SIGTERM, handle_signal)
    except ValueError as e:
        logger.warning(f"Could not register custom signal handlers: {e}")

    def trigger_graceful_exit():
        logger.info("System Tray: Commencing graceful shutdown...")
        global EVENT_LOOP
        if EVENT_LOOP is None:
            import sys
            sys.exit(0)

        def stop_loop():
            # 1. Stop active WebRTC connections
            try:
                webrtc_manager.cleanup()
            except Exception as e:
                logger.debug(f"WebRTC cleanup failed on exit: {e}")

            # 1.5. Release screen capture display handles
            try:
                screen_capture.close()
            except Exception as e:
                logger.debug(f"Screen capture close failed on exit: {e}")

            # 2. Release modifier keys
            try:
                import pyautogui
                for key in ["ctrl", "shift", "alt", "win"]:
                    pyautogui.keyUp(key)
            except Exception as e:
                logger.debug(f"pyautogui keyup failed on exit: {e}")

            # 3. Disconnect all operator connections
            disconnect_all_operators()

            # 4. Stop uvicorn event loop
            EVENT_LOOP.stop()

        EVENT_LOOP.call_soon_threadsafe(stop_loop)

    SYSTEM_TRAY = SystemTrayApp(
        disconnect_all_callback=disconnect_all_operators,
        input_lock_callback=set_remote_input_lock,
        exit_callback=trigger_graceful_exit
    )
    SYSTEM_TRAY.run()

    yield

    # Shutdown logic
    if SYSTEM_TRAY and SYSTEM_TRAY.icon:
        logger.info("Stopping system tray applet...")
        try:
            SYSTEM_TRAY.icon.stop()
        except Exception as e:
            logger.debug(f"Failed to stop system tray icon: {e}")
    try:
        screen_capture.close()
    except Exception as e:
        logger.debug(f"Failed to close screen capture handle on shutdown: {e}")

    logger.info("VNC Server shutting down. Releasing modifier keys...")
    try:
        import pyautogui
        for key in ["ctrl", "shift", "alt", "win"]:
            pyautogui.keyUp(key)
    except Exception as e:
        logger.debug(f"Failed to release keys on shutdown: {e}")

app.router.lifespan_context = lifespan

async def audio_sender_task(websocket: WebSocket, conn_id: str):
    audio_capture = AudioCapture()
    try:
        while True:
            start_time = time.time()
            chunk = await asyncio.to_thread(audio_capture.read_chunk, 100)
            if chunk:
                import base64
                encoded_audio = base64.b64encode(chunk).decode("utf-8")
                lock = ACTIVE_WEBSOCKET_LOCKS.get(conn_id)
                payload = {
                    "type": "audio",
                    "data": encoded_audio,
                    "sampleRate": audio_capture.sample_rate,
                    "channels": audio_capture.channels
                }
                if lock:
                    async with lock:
                        await websocket.send_json(payload)
                else:
                    await websocket.send_json(payload)
            elapsed = time.time() - start_time
            sleep_time = max(0.005, 0.1 - elapsed)
            await asyncio.sleep(sleep_time)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.debug(f"Audio sender error on connection {conn_id}: {e}")
    finally:
        audio_capture.cleanup()

# Security Header Enforcement Middleware
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self' data: https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self' ws: wss:; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )
    return response

# CORS Policy — configurable via ALLOWED_ORIGINS env var
_cors_origins = ALLOWED_ORIGIN_LIST if ALLOWED_ORIGIN_LIST else []
_cors_regex = (
    None if ALLOWED_ORIGIN_LIST
    else r"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?"
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_origin_regex=_cors_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token", "Authorization"],
)

class ApiPathRewriteMiddleware:
    """Middleware to strip the /api prefix from incoming paths for API and WebSocket routing compatibility."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            path = scope.get("path", "")
            if path.startswith("/api/"):
                scope["path"] = path[4:]
                if "raw_path" in scope:
                    raw_path = scope["raw_path"].decode("latin1")
                    if raw_path.startswith("/api/"):
                        scope["raw_path"] = raw_path[4:].encode("latin1")
        await self.app(scope, receive, send)

app.add_middleware(ApiPathRewriteMiddleware)

# ------------------ Auth Endpoints ------------------
@app.post("/auth/login")
async def login(credentials: dict, request: Request):
    """Checks credentials and returns a 15-minute JWT access token as an HttpOnly cookie."""
    username = credentials.get("username")
    password = credentials.get("password")
    role = credentials.get("role", "operator")
    client_ip = request.client.host if request.client else "unknown"

    if is_ip_banned(client_ip):
        await audit_logger.log_event("login_blocked_banned_ip", {"username": username, "ip": client_ip})
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Too many authentication failures. Your IP is banned for 30 minutes."
        )

    if username and password == SECURE_PASSWORD:
        csrf_token = secrets.token_hex(16)
        token = issue_token(username, role=role, csrf_token=csrf_token)
        response = JSONResponse(content={
            "status": "success",
            "role": role,
            "csrf_token": csrf_token,
            "expires_in": 900
        })
        is_secure = (request.url.scheme == "https") or (os.getenv("ENV", "development").lower() == "production")
        response.set_cookie(
            key="access_token",
            value=token,
            httponly=True,
            secure=is_secure,
            samesite="strict",
            max_age=900
        )
        clear_failed_attempts(client_ip)
        await audit_logger.log_event("login_success", {"username": username, "ip": client_ip, "role": role})
        return response

    track_failed_attempt(client_ip)
    await audit_logger.log_event("login_failed", {"username": username, "ip": client_ip})
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid credentials supplied"
    )

@app.post("/auth/logout")
async def logout(request: Request, current_user: TokenData = Depends(verify_token)):
    """Wipes the session cookie and signs out the user."""
    client_ip = request.client.host if request.client else "unknown"
    await audit_logger.log_event("logout", {"username": current_user.sub, "ip": client_ip})
    response = JSONResponse(content={"status": "success"})
    is_secure = (request.url.scheme == "https") or (os.getenv("ENV", "development").lower() == "production")
    response.delete_cookie(
        key="access_token",
        path="/",
        secure=is_secure,
        httponly=True,
        samesite="strict"
    )
    return response

@app.post("/auth/refresh")
async def refresh_token(request: Request, current_user: TokenData = Depends(verify_token)):
    """Issues a refreshed JWT token as an HttpOnly cookie."""
    new_csrf = secrets.token_hex(16)
    token = issue_token(current_user.sub, role=current_user.role, csrf_token=new_csrf)
    client_ip = request.client.host if request.client else "unknown"
    await audit_logger.log_event("token_refresh", {"username": current_user.sub, "ip": client_ip})
    response = JSONResponse(content={
        "status": "success",
        "role": current_user.role,
        "csrf_token": new_csrf
    })
    is_secure = (request.url.scheme == "https") or (os.getenv("ENV", "development").lower() == "production")
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=is_secure,
        samesite="strict",
        max_age=900
    )
    return response

# ------------------ Monitor Endpoints ------------------
@app.get("/monitors")
async def list_monitors(current_user: TokenData = Depends(verify_token)):
    """Returns a list of connected visual displays."""
    monitors = screen_capture.get_monitors()
    async with ANDROID_STREAM_LOCK:
        if ANDROID_SCREEN_STREAM is not None:
            monitors.append({
                "id": 99,
                "width": 720,
                "height": 1280,
                "is_primary": False,
                "name": "Android Screen Share"
            })
    return {"monitors": monitors}

# ------------------ Screen Sharing WebSocket ------------------
async def client_reader(websocket: WebSocket, session_config: dict):
    """Background reader task to receive and handle client messages on the socket."""
    conn_id = session_config.get("conn_id", "unknown")
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                if not isinstance(msg, dict):
                    logger.warning(f"Socket reader: Received non-dict packet from connection {conn_id}")
                    continue

                msg_type = msg.get("type")
                if msg_type == "quality_adjust":
                    try:
                        quality = int(msg.get("quality", 75))
                        session_config["quality"] = max(1, min(100, quality))
                    except (ValueError, TypeError):
                        pass

                    try:
                        scale = float(msg.get("scale", 1.0))
                        session_config["resolution_scale"] = max(0.1, min(2.0, scale))
                    except (ValueError, TypeError):
                        pass

                    if "rtt" in msg:
                        try:
                            session_config["rtt"] = float(msg["rtt"])
                        except (ValueError, TypeError):
                            pass
                elif msg_type == "pong":
                    session_config["last_pong_time"] = time.time()
                    if "rtt" in msg:
                        try:
                            session_config["rtt"] = float(msg["rtt"])
                        except (ValueError, TypeError):
                            pass
                elif msg_type == "webrtc_offer":
                    offer_sdp = msg.get("sdp")
                    offer_type = msg.get("offer_type", "offer")
                    if isinstance(offer_sdp, str):
                        webrtc_audio_capture = AudioCapture()
                        answer = await webrtc_manager.handle_offer(
                            offer_sdp,
                            offer_type,
                            screen_capture=screen_capture,
                            audio_capture=webrtc_audio_capture,
                            conn_id=conn_id
                        )
                        lock = ACTIVE_WEBSOCKET_LOCKS.get(conn_id)
                        if lock:
                            async with lock:
                                await websocket.send_json({
                                    "type": "webrtc_answer",
                                    "answer": answer
                                })
                        else:
                            await websocket.send_json({
                                "type": "webrtc_answer",
                                "answer": answer
                            })
                elif msg_type in ["mouse_move", "mouse_down", "mouse_up", "click", "double_click", "scroll", "key_press", "key_release", "key_combo"]:
                    current_user = session_config.get("user")
                    if current_user:
                        if REMOTE_INPUT_LOCKED and current_user.role != "administrator":
                            continue

                        if current_user.role == "viewer":
                            continue

                        monitor_id = msg.get("monitorId", 1)
                        if monitor_id == 99:
                            w = 720
                            h = 1280
                        else:
                            monitors = screen_capture.get_monitors()
                            if monitor_id < 1 or monitor_id >= len(monitors):
                                monitor_id = 1
                            w = monitors[monitor_id]["width"]
                            h = monitors[monitor_id]["height"]

                        try:
                            global LAST_INPUT_TIME
                            LAST_INPUT_TIME = time.time()

                            await asyncio.to_thread(input_validator.validate_and_execute, msg, w, h)
                            metrics_collector.total_inputs += 1

                            if msg_type in ["mouse_move", "click", "double_click", "mouse_down", "mouse_up"]:
                                presence_payload = {
                                    "type": "presence",
                                    "username": current_user.sub,
                                    "x": msg.get("x", 0.0),
                                    "y": msg.get("y", 0.0),
                                    "role": current_user.role
                                }
                                for peer_id, ws in list(ACTIVE_WEBSOCKETS.items()):
                                    if peer_id != conn_id:
                                        lock = ACTIVE_WEBSOCKET_LOCKS.get(peer_id)
                                        if lock:
                                            async def safe_send(w_conn, payload, lk):
                                                async with lk:
                                                    try:
                                                        await w_conn.send_json(payload)
                                                    except Exception:
                                                        pass
                                            asyncio.create_task(safe_send(ws, presence_payload, lock))
                        except Exception as e:
                            logger.debug(f"WebSocket input execution failed: {e}")
            except json.JSONDecodeError as e:
                logger.warning(f"Socket reader: Failed to parse JSON message: {e}")
            except Exception as e:
                logger.error(f"Socket reader: Error processing client packet: {e}")
    except asyncio.CancelledError:
        pass

@app.websocket("/ws/publish-screen")
async def websocket_publish_screen(websocket: WebSocket):
    """WebSocket endpoint where Android companion app streams its screen frames.
    Requires a valid session token passed as a query parameter.
    """
    global ANDROID_SCREEN_STREAM
    client_ip = websocket.client[0] if websocket.client else "unknown"

    # Require authentication before accepting the connection
    token = websocket.cookies.get("access_token") or websocket.query_params.get("token")
    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Missing auth token")
        return
    try:
        current_user = verify_token_string(token)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid or expired token")
        return

    # Only operators and administrators may publish screens
    if current_user.role not in ("operator", "administrator"):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Insufficient permissions")
        return

    try:
        await websocket.accept()
        logger.info(f"Android screen publisher connected from {client_ip} as {current_user.sub}")
        while True:
            data = await websocket.receive_bytes()
            if data:
                async with ANDROID_STREAM_LOCK:
                    ANDROID_SCREEN_STREAM = data
    except Exception as e:
        logger.info(f"Android screen publisher disconnected: {e}")
    finally:
        async with ANDROID_STREAM_LOCK:
            ANDROID_SCREEN_STREAM = None

@app.websocket("/ws/screen/{monitor_id}")
async def websocket_screen(websocket: WebSocket, monitor_id: int = 1):
    """WebSocket endpoint serving JPEG frames and sending keep-alive signals."""
    client_ip = websocket.client[0] if websocket.client else "unknown"
    conn_id = str(uuid.uuid4())

    # Protect against CSWSH: Validate Origin header
    origin = websocket.headers.get("origin")
    if origin:
        from urllib.parse import urlparse
        parsed_origin = urlparse(origin)
        origin_host = parsed_origin.netloc.lower()
        host = websocket.headers.get("host", "").lower()
        if host and origin_host != host:
            is_local = "localhost" in origin_host or "127.0.0.1" in origin_host or "0.0.0.0" in origin_host
            if not is_local:
                logger.warning(f"CSWSH blocked: Origin {origin} does not match Host {host}")
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Origin verification failed")
                return

    # Extract token from cookies or query parameters
    token = websocket.cookies.get("access_token")

    if not token:
        token = websocket.query_params.get("token")

    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Missing token credential")
        return

    try:
        current_user = verify_token_string(token)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid or expired token")
        return

    # Check connection rate limits
    if not connection_manager.add_connection(client_ip, conn_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="IP limit or capacity exceeded")
        return

    reader_task = None
    audio_task = None
    video_encoder = None
    try:
        await websocket.accept()
        logger.info(f"WebSocket connection {conn_id} accepted from {client_ip} on monitor {monitor_id}")
        await audit_logger.log_event("session_start", {"ip": client_ip, "conn_id": conn_id})

        # Initialize dynamic session configurations
        session_config = {
            "conn_id": conn_id,
            "quality": 75,
            "resolution_scale": 1.0,
            "last_pong_time": time.time(),
            "user": current_user
        }

        conn_lock = asyncio.Lock()
        ACTIVE_WEBSOCKETS[conn_id] = websocket
        ACTIVE_WEBSOCKET_LOCKS[conn_id] = conn_lock

        # Launch non-blocking concurrent reader task
        reader_task = asyncio.create_task(client_reader(websocket, session_config))
        # Launch concurrent audio capture task
        audio_task = asyncio.create_task(audio_sender_task(websocket, conn_id))

        frame_sequence = 0
        idle_frames = 0
        sleep_delay = 0.033

        while True:
            # Check for silent zombies (no heartbeat for 15 seconds)
            last_pong = session_config.get("last_pong_time", time.time())
            if time.time() - last_pong > 15.0:
                logger.warning(f"Connection {conn_id} heartbeat timeout. Cleaning up.")
                await audit_logger.log_event("heartbeat_timeout", {"ip": client_ip, "conn_id": conn_id})
                break

            quality = session_config["quality"]
            scale = session_config["resolution_scale"]
            target_w = int(1280 * scale)
            target_h = int(720 * scale)

            # Dynamic RTT frame rate adaptation: slow down capturing when RTT is high to avoid queue bloat
            rtt = session_config.get("rtt", 0.0)
            if rtt > 250.0:
                base_delay = 0.100  # 10 FPS
            elif rtt > 150.0:
                base_delay = 0.066  # 15 FPS
            else:
                base_delay = 0.033  # 30 FPS

            # Capture screen image frame (returns Base64 string, has_changed status, and tile coordinates)
            if monitor_id == 99:
                import base64
                async with ANDROID_STREAM_LOCK:
                    if ANDROID_SCREEN_STREAM is not None:
                        frame_data = base64.b64encode(ANDROID_SCREEN_STREAM).decode("utf-8")
                        has_changed = True
                        tx, ty, tw, th, is_delta = 0, 0, 720, 1280, False
                    else:
                        frame_data = None
                        has_changed = False
                        tx, ty, tw, th, is_delta = 0, 0, 0, 0, False
                if frame_data is None:
                    await asyncio.sleep(0.1)
                    continue
            else:
                frame_data, has_changed, tx, ty, tw, th, is_delta = screen_capture.capture(
                    monitor_id, quality=quality, resolution=(target_w, target_h)
                )

            if has_changed or (time.time() - LAST_INPUT_TIME < 1.5):
                idle_frames = 0
                sleep_delay = base_delay
            else:
                idle_frames += 1
                if idle_frames > 150:
                    sleep_delay = 0.200 # Idle frame decelerator: drop to 5 FPS

            # Send frame if updated, or force update once every 60 frames as keep-alive
            if frame_data and (has_changed or frame_sequence % 60 == 0):
                if not has_changed and frame_sequence % 60 == 0 and monitor_id != 99:
                    # Force full frame on keepalive updates
                    frame_data, _, tx, ty, tw, th, is_delta = screen_capture.capture(
                        monitor_id, quality=quality, resolution=(target_w, target_h), force_full=True
                    )

                if frame_data:
                    payload_frame = {
                        "type": "frame",
                        "sequence": frame_sequence,
                        "data": frame_data,
                        "x": tx,
                        "y": ty,
                        "w": tw,
                        "h": th,
                        "is_delta": is_delta,
                        "timestamp": datetime.now(timezone.utc).isoformat()
                    }
                    async with conn_lock:
                        await websocket.send_json(payload_frame)
                    metrics_collector.log_frame(len(frame_data))
                    frame_sequence += 1

            # Request latency RTT calculation every 30 iterations (~1 sec)
            if frame_sequence % 30 == 0:
                payload_ping = {
                    "type": "ping",
                    "id": frame_sequence,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                }
                async with conn_lock:
                    await websocket.send_json(payload_ping)

            await asyncio.sleep(sleep_delay)

    except Exception as e:
        logger.error(f"WebSocket session {conn_id} error: {e}")
    finally:
        # Clean up any associated WebRTC connection for this socket session ID
        try:
            await webrtc_manager.close_connection(conn_id)
        except Exception:
            pass

        if reader_task:
            reader_task.cancel()
        if audio_task:
            audio_task.cancel()
        if video_encoder:
            try:
                video_encoder.cleanup()
            except Exception:
                pass
        try:
            if reader_task:
                await reader_task
            if audio_task:
                await audio_task
        except asyncio.CancelledError:
            pass
        # Release any stuck modifiers on disconnect
        await asyncio.to_thread(input_validator.release_all_modifiers)
        ACTIVE_WEBSOCKETS.pop(conn_id, None)
        ACTIVE_WEBSOCKET_LOCKS.pop(conn_id, None)
        connection_manager.remove_connection(client_ip, conn_id)
        await audit_logger.log_event("session_end", {"ip": client_ip, "conn_id": conn_id})
        logger.info(f"WebSocket session {conn_id} destroyed")

# ------------------ Input Events API ------------------
@app.post("/input")
async def handle_input(data: dict, current_user: TokenData = Depends(verify_token), request: Request = None):
    """Receives and validates cursor movement, mouse clicks, and keystrokes."""
    if REMOTE_INPUT_LOCKED:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Remote control is temporarily locked by the server administrator."
        )
    if current_user.role == "viewer":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Interactive control is disabled for Viewer role"
        )

    global LAST_INPUT_TIME
    LAST_INPUT_TIME = time.time()

    event_type = data.get("type")
    if event_type in ["mouse_move", "click", "double_click", "mouse_down", "mouse_up"]:
        presence_payload = {
            "type": "presence",
            "username": current_user.sub,
            "x": data.get("x", 0.0),
            "y": data.get("y", 0.0),
            "role": current_user.role
        }
        for peer_id, ws in list(ACTIVE_WEBSOCKETS.items()):
            lock = ACTIVE_WEBSOCKET_LOCKS.get(peer_id)
            if lock:
                async def safe_send(w, payload, lk):
                    async with lk:
                        try:
                            await w.send_json(payload)
                        except Exception:
                            pass
                asyncio.create_task(safe_send(ws, presence_payload, lock))
            else:
                try:
                    asyncio.create_task(ws.send_json(presence_payload))
                except Exception:
                    pass

    if event_type and event_type != "mouse_move":
        client_ip = request.client.host if request and request.client else "unknown"
        await audit_logger.log_event("input_command", {
            "username": current_user.sub,
            "ip": client_ip,
            "event": data
        })

    try:
        monitor_id = data.get("monitorId", 1)
        if monitor_id == 99:
            w, h = 720, 1280
        else:
            monitors = screen_capture.get_monitors()
            monitor = next((m for m in monitors if m["id"] == monitor_id), monitors[0])
            w, h = monitor["width"], monitor["height"]

        result = await asyncio.to_thread(input_validator.validate_and_execute, data, w, h)
        metrics_collector.log_input(data.get("type", "unknown"))
        return result
    except ValueError as e:
        if "prohibited" in str(e):
            client_ip = request.client.host if request and request.client else "unknown"
            await audit_logger.log_event("security_violation_block", {
                "username": current_user.sub,
                "ip": client_ip,
                "detail": str(e),
                "event": data
            })
        raise HTTPException(status_code=400, detail=str(e))

# ------------------ Clipboard Sync API ------------------
@app.post("/clipboard")
async def set_clipboard(data: dict, current_user: TokenData = Depends(verify_token), request: Request = None):
    """Receives client text payload to update host clipboard."""
    client_ip = request.client.host if request and request.client else "unknown"
    await audit_logger.log_event("clipboard_sync", {
        "username": current_user.sub,
        "ip": client_ip,
        "length": len(data.get("data", ""))
    })
    await asyncio.to_thread(clipboard_manager.set_text, data.get("data"))
    return {"status": "success"}

@app.get("/clipboard")
async def get_clipboard(current_user: TokenData = Depends(verify_token)):
    """Fetches text payload from host clipboard."""
    text = await asyncio.to_thread(clipboard_manager.get_text)
    return {"data": text}

# Permitted commands for the remote terminal (whitelist approach to prevent RCE abuse)
_TERMINAL_ALLOWED_PREFIXES = (
    "dir", "ls", "pwd", "whoami", "hostname", "ipconfig", "ifconfig",
    "tasklist", "ps", "df", "free", "uptime", "date", "echo",
    "ping", "netstat", "cat", "type", "ver", "uname",
)

# ------------------ Remote Command Runner API ------------------
@app.post("/terminal/execute")
async def execute_terminal_command(
    data: dict,
    current_user: TokenData = Depends(verify_token),
    request: Request = None
):
    """Executes a whitelisted terminal command on the host. Restricted to administrators."""
    # C4 FIX: Restrict to administrator only — operators cannot run shell commands
    if current_user.role != "administrator":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators are permitted to execute remote commands."
        )

    command = data.get("command", "").strip()
    if not command:
        raise HTTPException(status_code=400, detail="Command content cannot be empty.")

    # C5 FIX: Whitelist check — reject commands not starting with a permitted prefix
    first_token = command.split()[0].lower().lstrip("./")
    if first_token not in _TERMINAL_ALLOWED_PREFIXES:
        client_ip = request.client.host if request and request.client else "unknown"
        await audit_logger.log_event("terminal_blocked", {
            "username": current_user.sub,
            "ip": client_ip,
            "command": command
        })
        raise HTTPException(
            status_code=400,
            detail=f"Command '{first_token}' is not in the permitted command list."
        )

    client_ip = request.client.host if request and request.client else "unknown"
    await audit_logger.log_event("remote_shell_execute", {
        "username": current_user.sub,
        "ip": client_ip,
        "command": command
    })

    try:
        # C5 FIX: Use exec (not shell) to prevent shell injection
        args = command.split()

        # Wrap Windows shell built-ins to execute via cmd.exe /c
        if sys.platform == "win32" and args:
            cmd_mapping = {
                "dir": ["cmd.exe", "/c", "dir"],
                "ls": ["cmd.exe", "/c", "dir"],
                "echo": ["cmd.exe", "/c", "echo"],
                "type": ["cmd.exe", "/c", "type"],
                "ver": ["cmd.exe", "/c", "ver"],
                "pwd": ["cmd.exe", "/c", "cd"],
            }
            first_cmd = args[0].lower()
            if first_cmd in cmd_mapping:
                args = cmd_mapping[first_cmd] + args[1:]

        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30.0)
        except asyncio.TimeoutError:
            proc.kill()
            return {"output": "Command timed out after 30 seconds.", "exit_code": -1}
        output_str = stdout.decode("utf-8", errors="replace") + stderr.decode("utf-8", errors="replace")
        return {
            "output": output_str,
            "exit_code": proc.returncode
        }
    except Exception as e:
        logger.error(f"Failed to execute command '{command}': {e}")
        return {
            "output": f"Internal execution error: {str(e)}",
            "exit_code": -1
        }

def get_downloads_dir():
    """Dynamically resolves the host user's Downloads directory, fallback to home."""
    from pathlib import Path
    home = Path.home()
    downloads = home / "Downloads"
    try:
        downloads.mkdir(parents=True, exist_ok=True)
        return downloads
    except Exception:
        return home

# ------------------ Remote File Transfer API ------------------
@app.post("/file/upload")
async def upload_file_to_host(
    file: UploadFile = File(...),
    current_user: TokenData = Depends(verify_token),
    request: Request = None
):
    """Receives binary stream and saves it to the host Downloads directory.
    Enforces file size limits and sanitizes filenames.
    """
    if current_user.role not in ["operator", "administrator"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions to upload files to host."
        )

    from pathlib import Path
    filename = Path(file.filename).name if file.filename else ""
    if not filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid or unsafe filename.")

    # Sanitize: allow only safe characters in filenames
    import re
    if not re.match(r'^[\w\-. ()]+$', filename):
        raise HTTPException(status_code=400, detail="Filename contains disallowed characters.")

    dest_dir = get_downloads_dir()
    dest_path = dest_dir / filename

    client_ip = request.client.host if request and request.client else "unknown"
    await audit_logger.log_event("file_upload_start", {
        "username": current_user.sub,
        "ip": client_ip,
        "filename": filename,
        "destination": str(dest_path)
    })

    max_bytes = MAX_UPLOAD_SIZE_MB * 1024 * 1024
    try:
        # H1 FIX: Stream file to disk with size enforcement
        bytes_written = 0
        with open(dest_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB chunks
                if not chunk:
                    break
                bytes_written += len(chunk)
                if bytes_written > max_bytes:
                    f.close()
                    dest_path.unlink(missing_ok=True)
                    raise HTTPException(
                        status_code=413,
                        detail=f"File exceeds maximum allowed size of {MAX_UPLOAD_SIZE_MB}MB."
                    )
                f.write(chunk)

        await audit_logger.log_event("file_upload_success", {
            "username": current_user.sub,
            "ip": client_ip,
            "filename": filename,
            "size_bytes": bytes_written
        })
        return {"status": "success", "filename": filename, "path": str(dest_path)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"File upload error for '{filename}': {e}")
        if dest_path.exists():
            try:
                dest_path.unlink()
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"File save error: {str(e)}")

# ------------------ Host System Info API ------------------
def get_clean_cpu_name() -> str:
    """Queries OS specific APIs to resolve clean human-readable CPU string name."""
    import platform
    try:
        if platform.system() == "Windows":
            import winreg
            key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
            cpu_name, _ = winreg.QueryValueEx(key, "ProcessorNameString")
            return cpu_name.strip()
    except Exception:
        pass
    return platform.processor() or "Unknown CPU"

@app.get("/system/info")
async def get_system_info(current_user: TokenData = Depends(verify_token)):
    """Returns host machine Operating System, CPU model, Memory load, and Storage metrics."""
    import platform
    import psutil

    os_name = f"{platform.system()} {platform.release()}"
    cpu_name = get_clean_cpu_name()

    mem = psutil.virtual_memory()
    memory_info = {
        "used_gb": mem.used / (1024 ** 3),
        "total_gb": mem.total / (1024 ** 3),
        "percent": mem.percent
    }

    try:
        path = "C:\\" if platform.system() == "Windows" else "/"
        disk = psutil.disk_usage(path)
        storage_info = {
            "used_gb": disk.used / (1024 ** 3),
            "total_gb": disk.total / (1024 ** 3),
            "percent": disk.percent,
            "free_gb": disk.free / (1024 ** 3)
        }
    except Exception:
        storage_info = {
            "used_gb": 0.0,
            "total_gb": 0.0,
            "percent": 0.0,
            "free_gb": 0.0
        }

    return {
        "os": os_name,
        "cpu": cpu_name,
        "memory": memory_info,
        "storage": storage_info
    }

# ------------------ Encrypted Audit Log API ------------------
# C6 FIX: Route registered without /api/ prefix so ApiPathRewriteMiddleware routes correctly
@app.get("/audit/logs")
async def get_audit_logs(current_user: TokenData = Depends(verify_token)):
    """Returns decrypted audit logs, strictly restricted to server administrators."""
    if current_user.role != "administrator":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators are authorized to view system audit logs."
        )
    return await audit_logger.get_decrypted_events(limit=55)

# ------------------ Health & Telemetry ------------------
@app.get("/metrics")
async def get_metrics(current_user: TokenData = Depends(verify_token)):
    """Returns runtime diagnostics data."""
    return {
        "active_connections": connection_manager.count_connections(),
        "uptime_seconds": round(metrics_collector.get_uptime(), 2),
        "total_frames_sent": metrics_collector.total_frames,
        "total_inputs_received": metrics_collector.total_inputs,
        "memory_usage_mb": round(metrics_collector.get_memory_usage(), 2),
        "rolling_bandwidth_kbs": round(metrics_collector.get_rolling_bandwidth_kbs(), 2)
    }

@app.get("/health")
async def health_check():
    """Returns a basic server health response."""
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

# ------------------ Static Frontend Hosting & Fallbacks ------------------
if getattr(sys, "frozen", False):
    # PyInstaller extracts resources to sys._MEIPASS at runtime
    dist_path = os.path.join(sys._MEIPASS, "frontend", "dist")
else:
    dist_path = os.getenv("FRONTEND_DIST_PATH", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")))
assets_path = os.path.join(dist_path, "assets")

if os.path.isdir(assets_path):
    logger.info(f"Mounting static files from {assets_path} under /assets")
    app.mount("/assets", StaticFiles(directory=assets_path), name="assets")
else:
    logger.warning(f"Static assets directory not found at {assets_path}. Production frontend may not be served.")

@app.get("/")
async def serve_index():
    index_file = os.path.join(dist_path, "index.html")
    if os.path.isfile(index_file):
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="Frontend build (index.html) not found.")

@app.get("/{catchall:path}")
async def serve_static_or_spa(catchall: str):
    # Check if the requested file exists in dist_path (for favicon.ico, manifest.json, robots.txt, etc.)
    file_path = os.path.join(dist_path, catchall)
    if os.path.isfile(file_path):
        return FileResponse(file_path)

    # If the path looks like a backend API or websocket endpoint, return 404
    if any(catchall.startswith(prefix) for prefix in ["auth", "monitors", "input", "clipboard", "metrics", "health", "ws"]):
        raise HTTPException(status_code=404, detail="Not Found")

    # Fallback to SPA routing index.html
    index_file = os.path.join(dist_path, "index.html")
    if os.path.isfile(index_file):
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="Frontend build (index.html) not found.")

def generate_self_signed_certs() -> tuple[str, str]:
    """Generates a temporary self-signed certificate and key for HTTPS/WSS."""
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    import datetime

    logger.info("Auto SSL: Generating temporary self-signed certificate...")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "California"),
        x509.NameAttribute(NameOID.LOCALITY_NAME, "Mountain View"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Antigravity VNC"),
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
    ])

    cert = x509.CertificateBuilder().subject_name(
        subject
    ).issuer_name(
        issuer
    ).public_key(
        key.public_key()
    ).serial_number(
        x509.random_serial_number()
    ).not_valid_before(
        datetime.datetime.now(datetime.timezone.utc)
    ).not_valid_after(
        datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=365)
    ).add_extension(
        x509.SubjectAlternativeName([
            x509.DNSName("localhost"),
            x509.IPAddress(ipaddress.IPv4Address("127.0.0.1"))
        ]),
        critical=False,
    ).sign(key, hashes.SHA256())

    certs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "certs")
    os.makedirs(certs_dir, exist_ok=True)
    key_path = os.path.join(certs_dir, "key.pem")
    cert_path = os.path.join(certs_dir, "cert.pem")

    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()
        ))

    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    logger.info(f"Auto SSL: Certificate generated successfully at {cert_path}")
    return key_path, cert_path

if __name__ == "__main__":
    import uvicorn

    ssl_key_file = os.getenv("SSL_KEY_FILE")
    ssl_cert_file = os.getenv("SSL_CERT_FILE")

    # Auto SSL logic
    if os.getenv("AUTO_SSL", "false").lower() == "true" and (not ssl_key_file or not ssl_cert_file):
        ssl_key_file, ssl_cert_file = generate_self_signed_certs()

    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        ssl_keyfile=ssl_key_file,
        ssl_certfile=ssl_cert_file
    )
