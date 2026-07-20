# backend/auth.py
import jwt
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, List
from collections import defaultdict
from pydantic import BaseModel, ValidationError
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import os
import logging

logger = logging.getLogger(__name__)

# IP -> list of failed attempt datetimes in last 10 minutes
FAILED_ATTEMPTS: Dict[str, List[datetime]] = defaultdict(list)
# IP -> ban expiration datetime
BANNED_IPS: Dict[str, datetime] = {}
# jti -> exp_datetime for blacklisted (logged out) tokens
TOKEN_BLACKLIST: Dict[str, datetime] = {}

# Reentrant lock to prevent multi-threaded dictionary state mutation crashes
AUTH_LOCK = threading.RLock()

def prune_expired_auth_records():
    """Prunes expired ban, failed attempt, and token blacklist records to prevent memory growth leaks."""
    with AUTH_LOCK:
        now = datetime.now(timezone.utc)
        expired_bans = [ip for ip, exp in BANNED_IPS.items() if now > exp]
        for ip in expired_bans:
            BANNED_IPS.pop(ip, None)
            FAILED_ATTEMPTS.pop(ip, None)

        for ip, attempts in list(FAILED_ATTEMPTS.items()):
            valid_attempts = [t for t in attempts if now - t < timedelta(minutes=10)]
            if not valid_attempts:
                FAILED_ATTEMPTS.pop(ip, None)
            else:
                FAILED_ATTEMPTS[ip] = valid_attempts

        expired_blacklists = [jti for jti, exp in TOKEN_BLACKLIST.items() if now > exp]
        for jti in expired_blacklists:
            TOKEN_BLACKLIST.pop(jti, None)

        # Enforce hard upper boundaries to prevent memory DoS
        if len(BANNED_IPS) > 10000:
            sorted_bans = sorted(BANNED_IPS.items(), key=lambda x: x[1])
            for ip, _ in sorted_bans[:len(BANNED_IPS) - 10000]:
                BANNED_IPS.pop(ip, None)

        if len(FAILED_ATTEMPTS) > 10000:
            excess = len(FAILED_ATTEMPTS) - 10000
            for ip in list(FAILED_ATTEMPTS.keys())[:excess]:
                FAILED_ATTEMPTS.pop(ip, None)

def track_failed_attempt(ip: str):
    """Tracks login failures. If 5 failures occur in 10 minutes, bans IP for 30 minutes."""
    with AUTH_LOCK:
        prune_expired_auth_records()
        now = datetime.now(timezone.utc)
        FAILED_ATTEMPTS[ip].append(now)
        FAILED_ATTEMPTS[ip] = [t for t in FAILED_ATTEMPTS[ip] if now - t < timedelta(minutes=10)]

        if len(FAILED_ATTEMPTS[ip]) >= 5:
            BANNED_IPS[ip] = now + timedelta(minutes=30)
            logger.warning(f"IP {ip} banned for 30 minutes due to 5 consecutive auth failures.")

def is_ip_banned(ip: str) -> bool:
    """Checks if IP is currently banned, cleans up expired ban records."""
    with AUTH_LOCK:
        prune_expired_auth_records()
        if ip not in BANNED_IPS:
            return False
        now = datetime.now(timezone.utc)
        if now > BANNED_IPS[ip]:
            BANNED_IPS.pop(ip, None)
            FAILED_ATTEMPTS.pop(ip, None)
            return False
        return True

def clear_failed_attempts(ip: str):
    """Wipes failed attempt tracker for the given IP address."""
    with AUTH_LOCK:
        FAILED_ATTEMPTS.pop(ip, None)

def blacklist_token(jti: str, exp: datetime) -> None:
    """Explicitly adds a JWT unique identifier (jti) to the revocation blacklist."""
    with AUTH_LOCK:
        TOKEN_BLACKLIST[jti] = exp

def is_token_blacklisted(jti: str) -> bool:
    """Checks if a token JTI has been revoked, automatically pruning it if it has naturally expired."""
    with AUTH_LOCK:
        if jti not in TOKEN_BLACKLIST:
            return False
        now = datetime.now(timezone.utc)
        if now > TOKEN_BLACKLIST[jti]:
            TOKEN_BLACKLIST.pop(jti, None)
            return False
        return True

SECRET_KEY = os.getenv("SECRET_KEY")
if not SECRET_KEY:
    _env_mode = os.getenv("ENV", "development").lower()
    if _env_mode == "production":
        import sys
        logger.critical(
            "SECRET_KEY environment variable is not set. "
            "All JWT tokens will be insecure. Refusing to start in production mode."
        )
        sys.exit(1)
    else:
        import hashlib
        SECRET_KEY = hashlib.sha256(f"VNC_STABLE_DEV_SECRET_{os.path.abspath(__file__)}".encode()).hexdigest()
        logger.warning(
            "SECRET_KEY not explicitly set in .env — using a stable local development key. "
            "Set SECRET_KEY in production."
        )
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "15"))

security = HTTPBearer(auto_error=False)

class TokenData(BaseModel):
    sub: str
    exp: datetime
    iat: datetime
    jti: str
    role: str
    csrf_token: str

def issue_token(username: str, role: str = "operator", csrf_token: Optional[str] = None) -> str:
    """Issue JWT token"""
    jti = secrets.token_hex(16)
    now = datetime.now(timezone.utc)
    if not csrf_token:
        csrf_token = secrets.token_hex(16)
    payload = {
        "sub": username,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "iat": now,
        "jti": jti,
        "role": role,
        "csrf_token": csrf_token
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)

def verify_token_string(token: str) -> TokenData:
    """Verify raw token string directly"""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        jti = payload.get("jti", "")
        if jti and is_token_blacklisted(jti):
            raise HTTPException(status_code=401, detail="Token has been revoked/logged out")
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(status_code=401, detail="Invalid token payload")

        role: str = payload.get("role", "operator")
        csrf_token: str = payload.get("csrf_token", "")
        return TokenData(
            sub=username,
            exp=datetime.fromtimestamp(payload["exp"], tz=timezone.utc),
            iat=datetime.fromtimestamp(payload["iat"], tz=timezone.utc),
            jti=payload["jti"],
            role=role,
            csrf_token=csrf_token
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except (jwt.InvalidTokenError, ValidationError, KeyError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid token")

def verify_token(request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> TokenData:
    """FastAPI HTTP dependency for verifying token from cookies or Authorization header, enforcing CSRF checks."""
    ip = request.client.host if request.client else "unknown"
    if is_ip_banned(ip):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="IP address is currently banned due to brute-force protection."
        )
    token = request.cookies.get("access_token")
    if not token and credentials:
        token = credentials.credentials

    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session authorization credentials missing"
        )

    token_data = verify_token_string(token)

    # CSRF Token validation for write methods
    if request.method in ["POST", "PUT", "DELETE"]:
        # Exempt /auth/refresh and /auth/logout from CSRF checks to allow session auto-recovery and logout cleanups
        path = request.url.path
        if not (path.endswith("/auth/refresh") or path.endswith("/auth/logout")):
            csrf_header = request.headers.get("X-CSRF-Token")
            if not csrf_header or csrf_header != token_data.csrf_token:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="CSRF token validation failed"
                )

    return token_data
