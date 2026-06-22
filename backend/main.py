# backend/main.py
from fastapi import FastAPI, WebSocket, HTTPException, Request, Depends, status
from fastapi.responses import JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import json
import logging
import asyncio
from datetime import datetime, timezone
import uuid
import os
import secrets
import time

import ipaddress
from auth import issue_token, verify_token, verify_token_string, TokenData, track_failed_attempt, is_ip_banned, clear_failed_attempts
from rate_limit import ConnectionManager
from screen_capture import ScreenCapture
from input_handler import InputValidator
from metrics import MetricsCollector
from clipboard import ClipboardManager
from audit import AuditLogger
from video_encoder import VideoEncoder
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
SECURE_PASSWORD = os.getenv("SECURE_PASSWORD", "your_secure_password")
MAX_PER_IP = int(os.getenv("MAX_CONNECTIONS_PER_IP", "3"))
MAX_GLOBAL = int(os.getenv("MAX_GLOBAL_CONNECTIONS", "10"))

# Initialize system resources
connection_manager = ConnectionManager(max_per_ip=MAX_PER_IP, max_global=MAX_GLOBAL)
screen_capture = ScreenCapture()
input_validator = InputValidator()
metrics_collector = MetricsCollector()
clipboard_manager = ClipboardManager()
audit_logger = AuditLogger()
webrtc_manager = WebRTCSessionManager()
LAST_INPUT_TIME = 0.0
ACTIVE_WEBSOCKETS = {}
REMOTE_INPUT_LOCKED = False

def disconnect_all_operators():
    logger.info("System Tray: Disconnecting all remote operators...")
    for conn_id, ws in list(ACTIVE_WEBSOCKETS.items()):
        try:
            asyncio.run_coroutine_threadsafe(
                ws.close(code=status.WS_1001_GOING_AWAY, reason="Session terminated by server admin"),
                asyncio.get_event_loop()
            )
        except Exception as e:
            logger.debug(f"Failed to force close socket: {e}")

def set_remote_input_lock(locked: bool):
    global REMOTE_INPUT_LOCKED
    REMOTE_INPUT_LOCKED = locked

@app.on_event("startup")
def start_system_tray():
    tray = SystemTrayApp(
        disconnect_all_callback=disconnect_all_operators,
        input_lock_callback=set_remote_input_lock
    )
    tray.run()

async def audio_sender_task(websocket: WebSocket, conn_id: str):
    audio_capture = AudioCapture()
    try:
        while True:
            chunk = audio_capture.read_chunk(100)
            if chunk:
                import base64
                encoded_audio = base64.b64encode(chunk).decode("utf-8")
                await websocket.send_json({
                    "type": "audio",
                    "data": encoded_audio,
                    "sampleRate": audio_capture.sample_rate,
                    "channels": audio_capture.channels
                })
            await asyncio.sleep(0.1)
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.debug(f"Audio sender error on connection {conn_id}: {e}")

@app.on_event("shutdown")
def release_keys_on_shutdown():
    logger.info("VNC Server shutting down. Releasing modifier keys...")
    try:
        import pyautogui
        for key in ["ctrl", "shift", "alt", "win"]:
            pyautogui.keyUp(key)
    except Exception as e:
        logger.debug(f"Failed to release keys on shutdown: {e}")

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
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline'; "
        "font-src 'self' data:; "
        "img-src 'self' data:; "
        "connect-src 'self' ws: wss:; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )
    return response

# CORS Policy - Restrict origin in production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ------------------ Auth Endpoints ------------------
@app.post("/auth/login")
async def login(credentials: dict, request: Request):
    """Checks credentials and returns a 15-minute JWT access token as an HttpOnly cookie."""
    username = credentials.get("username")
    password = credentials.get("password")
    role = credentials.get("role", "operator")
    client_ip = request.client.host if request.client else "unknown"
    
    if is_ip_banned(client_ip):
        audit_logger.log_event("login_blocked_banned_ip", {"username": username, "ip": client_ip})
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
        response.set_cookie(
            key="access_token",
            value=token,
            httponly=True,
            secure=False,  # Set to True in production to enforce HTTPS
            samesite="lax",
            max_age=900
        )
        clear_failed_attempts(client_ip)
        audit_logger.log_event("login_success", {"username": username, "ip": client_ip, "role": role})
        return response
        
    track_failed_attempt(client_ip)
    audit_logger.log_event("login_failed", {"username": username, "ip": client_ip})
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED, 
        detail="Invalid credentials supplied"
    )

@app.post("/auth/logout")
async def logout(request: Request):
    """Wipes the session cookie and signs out the user."""
    client_ip = request.client.host if request.client else "unknown"
    audit_logger.log_event("logout", {"ip": client_ip})
    response = JSONResponse(content={"status": "success"})
    response.delete_cookie(key="access_token")
    return response

@app.post("/auth/refresh")
async def refresh_token(request: Request, current_user: TokenData = Depends(verify_token)):
    """Issues a refreshed JWT token as an HttpOnly cookie."""
    new_csrf = secrets.token_hex(16)
    token = issue_token(current_user.sub, role=current_user.role, csrf_token=new_csrf)
    client_ip = request.client.host if request.client else "unknown"
    audit_logger.log_event("token_refresh", {"username": current_user.sub, "ip": client_ip})
    response = JSONResponse(content={
        "status": "success",
        "role": current_user.role,
        "csrf_token": new_csrf
    })
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=900
    )
    return response

# ------------------ Monitor Endpoints ------------------
@app.get("/monitors")
async def list_monitors(current_user: TokenData = Depends(verify_token)):
    """Returns a list of connected visual displays."""
    return {"monitors": screen_capture.get_monitors()}

# ------------------ Screen Sharing WebSocket ------------------
async def client_reader(websocket: WebSocket, session_config: dict):
    """Background reader task to receive and handle client messages on the socket."""
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            if msg.get("type") == "quality_adjust":
                session_config["quality"] = int(msg.get("quality", 75))
                session_config["resolution_scale"] = float(msg.get("scale", 1.0))
            elif msg.get("type") == "pong":
                session_config["last_pong_time"] = time.time()
            elif msg.get("type") == "webrtc_offer":
                offer_sdp = msg.get("sdp")
                offer_type = msg.get("offer_type", "offer")
                answer = await webrtc_manager.handle_offer(offer_sdp, offer_type)
                await websocket.send_json({
                    "type": "webrtc_answer",
                    "answer": answer
                })
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.debug(f"WebSocket client reader exception: {e}")

@app.websocket("/ws/screen/{monitor_id}")
async def websocket_screen(websocket: WebSocket, monitor_id: int = 1):
    """WebSocket endpoint serving JPEG frames and sending keep-alive signals."""
    client_ip = websocket.client[0] if websocket.client else "unknown"
    conn_id = str(uuid.uuid4())

    # Extract token from cookies or query parameters
    cookie_header = websocket.headers.get("cookie")
    token = None
    if cookie_header:
        try:
            cookies = dict(item.split("=", 1) for item in cookie_header.split("; ") if "=" in item)
            token = cookies.get("access_token")
        except Exception:
            pass

    if not token:
        token = websocket.query_params.get("token")

    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Missing token credential")
        return
        
    try:
        verify_token_string(token)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid or expired token")
        return

    # Check connection rate limits
    if not connection_manager.add_connection(client_ip, conn_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="IP limit or capacity exceeded")
        return

    await websocket.accept()
    logger.info(f"WebSocket connection {conn_id} accepted from {client_ip} on monitor {monitor_id}")
    audit_logger.log_event("session_start", {"ip": client_ip, "conn_id": conn_id})

    # Initialize dynamic session configurations
    session_config = {
        "quality": 75,
        "resolution_scale": 1.0,
        "last_pong_time": time.time()
    }

    ACTIVE_WEBSOCKETS[conn_id] = websocket

    # Launch non-blocking concurrent reader task
    reader_task = asyncio.create_task(client_reader(websocket, session_config))
    # Launch concurrent audio capture task
    audio_task = asyncio.create_task(audio_sender_task(websocket, conn_id))
    
    # Initialize H.264 video encoder
    video_encoder = VideoEncoder(fps=30)
    
    frame_sequence = 0
    idle_frames = 0
    sleep_delay = 0.033

    try:
        while True:
            # Check for silent zombies (no heartbeat for 15 seconds)
            last_pong = session_config.get("last_pong_time", time.time())
            if time.time() - last_pong > 15.0:
                logger.warning(f"Connection {conn_id} heartbeat timeout. Cleaning up.")
                audit_logger.log_event("heartbeat_timeout", {"ip": client_ip, "conn_id": conn_id})
                break

            quality = session_config["quality"]
            scale = session_config["resolution_scale"]
            target_w = int(1280 * scale)
            target_h = int(720 * scale)

            video_frame = None
            if video_encoder.available:
                pil_img = screen_capture.capture_pil(monitor_id, resolution=(target_w, target_h))
                if pil_img:
                    video_frame = video_encoder.encode_frame(pil_img)
            
            if video_frame:
                import base64
                encoded_video = base64.b64encode(video_frame).decode("utf-8")
                await websocket.send_json({
                    "type": "video_frame",
                    "sequence": frame_sequence,
                    "data": encoded_video,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })
                metrics_collector.log_frame(len(encoded_video))
                frame_sequence += 1
                idle_frames = 0
                sleep_delay = 0.033
            else:
                # Capture screen image frame (returns Base64 string, has_changed status, and tile coordinates)
                frame_data, has_changed, tx, ty, tw, th, is_delta = screen_capture.capture(
                    monitor_id, quality=quality, resolution=(target_w, target_h)
                )
                
                if has_changed or (time.time() - LAST_INPUT_TIME < 1.5):
                    idle_frames = 0
                    sleep_delay = 0.033
                else:
                    idle_frames += 1
                    if idle_frames > 150:
                        sleep_delay = 0.200 # Idle frame decelerator: drop to 5 FPS

                # Send frame if updated, or force update once every 60 frames as keep-alive
                if frame_data and (has_changed or frame_sequence % 60 == 0):
                    if not has_changed and frame_sequence % 60 == 0:
                        # Force full frame on keepalive updates
                        frame_data, _, tx, ty, tw, th, is_delta = screen_capture.capture(
                            monitor_id, quality=quality, resolution=(target_w, target_h), force_full=True
                        )

                    if frame_data:
                        await websocket.send_json({
                            "type": "frame",
                            "sequence": frame_sequence,
                            "data": frame_data,
                            "x": tx,
                            "y": ty,
                            "w": tw,
                            "h": th,
                            "is_delta": is_delta,
                            "timestamp": datetime.now(timezone.utc).isoformat()
                        })
                        metrics_collector.log_frame(len(frame_data))
                        frame_sequence += 1

            # Request latency RTT calculation every 30 iterations (~1 sec)
            if frame_sequence % 30 == 0:
                await websocket.send_json({
                    "type": "ping",
                    "id": frame_sequence,
                    "timestamp": datetime.now(timezone.utc).isoformat()
                })

            await asyncio.sleep(sleep_delay)

    except Exception as e:
        logger.error(f"WebSocket session {conn_id} error: {e}")
    finally:
        reader_task.cancel()
        audio_task.cancel()
        video_encoder.cleanup()
        try:
            await reader_task
            await audio_task
        except asyncio.CancelledError:
            pass
        ACTIVE_WEBSOCKETS.pop(conn_id, None)
        connection_manager.remove_connection(client_ip, conn_id)
        audit_logger.log_event("session_end", {"ip": client_ip, "conn_id": conn_id})
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
            try:
                asyncio.create_task(ws.send_json(presence_payload))
            except Exception:
                pass

    if event_type and event_type != "mouse_move":
        client_ip = request.client.host if request and request.client else "unknown"
        audit_logger.log_event("input_command", {
            "username": current_user.sub,
            "ip": client_ip,
            "event": data
        })

    try:
        monitor_id = data.get("monitorId", 1)
        monitors = screen_capture.get_monitors()
        monitor = next((m for m in monitors if m["id"] == monitor_id), monitors[0])
        w, h = monitor["width"], monitor["height"]
        
        result = input_validator.validate_and_execute(data, w, h)
        metrics_collector.log_input(data.get("type", "unknown"))
        return result
    except ValueError as e:
        if "prohibited" in str(e):
            client_ip = request.client.host if request and request.client else "unknown"
            audit_logger.log_event("security_violation_block", {
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
    audit_logger.log_event("clipboard_sync", {
        "username": current_user.sub,
        "ip": client_ip,
        "length": len(data.get("data", ""))
    })
    clipboard_manager.set_text(data.get("data"))
    return {"status": "success"}

@app.get("/clipboard")
async def get_clipboard(current_user: TokenData = Depends(verify_token)):
    """Fetches text payload from host clipboard."""
    text = clipboard_manager.get_text()
    return {"data": text}

# ------------------ Health & Telemetry ------------------
@app.get("/metrics")
async def get_metrics(current_user: TokenData = Depends(verify_token)):
    """Returns runtime diagnostics data."""
    return {
        "active_connections": connection_manager.count_connections(),
        "uptime_seconds": round(metrics_collector.get_uptime(), 2),
        "total_frames_sent": metrics_collector.total_frames,
        "total_inputs_received": metrics_collector.total_inputs,
        "memory_usage_mb": round(metrics_collector.get_memory_usage(), 2)
    }

@app.get("/health")
async def health_check():
    """Returns a basic server health response."""
    return {
        "status": "healthy",
        "timestamp": datetime.now(timezone.utc).isoformat()
    }

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
