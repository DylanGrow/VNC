# backend/auth.py
import jwt
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, List
from collections import defaultdict
from pydantic import BaseModel
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthCredentials
import os
import logging

logger = logging.getLogger(__name__)

# IP -> list of failed attempt datetimes in last 10 minutes
FAILED_ATTEMPTS: Dict[str, List[datetime]] = defaultdict(list)
# IP -> ban expiration datetime
BANNED_IPS: Dict[str, datetime] = {}

def track_failed_attempt(ip: str):
    """Tracks login failures. If 5 failures occur in 10 minutes, bans IP for 30 minutes."""
    now = datetime.now(timezone.utc)
    FAILED_ATTEMPTS[ip].append(now)
    FAILED_ATTEMPTS[ip] = [t for t in FAILED_ATTEMPTS[ip] if now - t < timedelta(minutes=10)]
    
    if len(FAILED_ATTEMPTS[ip]) >= 5:
        BANNED_IPS[ip] = now + timedelta(minutes=30)
        logger.warning(f"IP {ip} banned for 30 minutes due to 5 consecutive auth failures.")

def is_ip_banned(ip: str) -> bool:
    """Checks if IP is currently banned, cleans up expired ban records."""
    if ip not in BANNED_IPS:
        return False
    now = datetime.now(timezone.utc)
    if now > BANNED_IPS[ip]:
        del BANNED_IPS[ip]
        if ip in FAILED_ATTEMPTS:
            del FAILED_ATTEMPTS[ip]
        return False
    return True

def clear_failed_attempts(ip: str):
    """Wipes failed attempt tracker for the given IP address."""
    if ip in FAILED_ATTEMPTS:
        del FAILED_ATTEMPTS[ip]

SECRET_KEY = os.getenv("SECRET_KEY", "change_this_to_a_very_secure_random_string_at_least_32_bytes_long")
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
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

def verify_token(request: Request, credentials: Optional[HTTPAuthCredentials] = Depends(security)) -> TokenData:
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
        csrf_header = request.headers.get("X-CSRF-Token")
        if not csrf_header or csrf_header != token_data.csrf_token:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="CSRF token validation failed"
            )
            
    return token_data
