# Antigravity VNC System

A secure, high-performance, production-ready VNC Screen Sharing system built with **FastAPI** (Python backend) and **Vite + TypeScript + TailwindCSS** (Frontend client).

The system integrates 15 core architectural, security, and performance optimizations (including token-based WebSocket authentication, sliding window IP limiters, delta frame caching, canvas image element reuse, and double-buffered layouts).

---

## 🏗️ Architectural Overview

```
                          +---------------------------------------+
                          |        Frontend Client Browser        |
                          |  (Canvas, Inputs, Clipboard, HUD)    |
                          +---------------------------------------+
                                   /                     \
                      REST Post   /                       \   Secure WS
                      (Inputs)   /                         \  (JPEG Stream)
                                v                           v
                 +-----------------------+         +-----------------------+
                 |  FastAPI Input API    |         | FastAPI WS Streamer   |
                 |  & Event Validator    |         | & IP Rate Limiter     |
                 +-----------------------+         +-----------------------+
                                \                           /
                                 \                         /
                                  v                       v
                          +---------------------------------------+
                          |             OS Subsystem              |
                          |    (Display Capture, Input Emul)      |
                          +---------------------------------------+
```

---

## 📁 Codebase Directory Structure

```
vnc-system/
├── backend/
│   ├── main.py                 # Primary FastAPI Server
│   ├── auth.py                 # JWT token issuer & authenticator
│   ├── rate_limit.py           # Sliding WebSocket IP connection manager
│   ├── screen_capture.py       # low-latency MSS captures with fallbacks
│   ├── input_handler.py        # Keystroke whitelister & coordinate scaler
│   ├── clipboard.py            # OS-clipboard hook manager
│   ├── metrics.py              # Telemetry & performance statistics
│   ├── requirements.txt        # Backend dependencies
│   └── .env.example            # Environment configurations template
│
├── frontend/
│   ├── src/
│   │   ├── main.ts             # Application entry script
│   │   ├── app.ts              # Coordinating core application
│   │   ├── renderer.ts         # Double-buffered Canvas & Image pool
│   │   ├── input-handler.ts    # Throttling mouse & key listeners
│   │   ├── connection.ts       # WebSocket protocol & HUD binder
│   │   ├── reconnection.ts     # Exponential backoff with jitter
│   │   ├── metrics.ts          # RTT latency & FPS trackers
│   │   ├── frame-buffer.ts     # Sequence order buffer
│   │   ├── clipboard.ts        # Client clipboard buttons & sync hooks
│   │   ├── validation.ts       # Type-safe Zod payload schemas
│   │   └── style.css           # Tailwind custom styles
│   │
│   ├── public/
│   │   ├── manifest.json       # PWA manifest
│   │   ├── favicon.ico         # Placeholder favicon
│   │   ├── robots.txt          # Crawling restrictions
│   │   └── sitemap.xml         # XML Sitemap
│   │
│   ├── package.json            # Node dependencies & commands
│   ├── vite.config.ts          # Vite build & proxy routes
│   ├── tsconfig.json           # TypeScript configuration compiler
│   ├── tailwind.config.js      # Tailwind layout specifications
│   └── postcss.config.js       # PostCSS compiler configurations
│
└── .github/workflows/
    └── deploy.yml              # CI Build & Syntax compilation actions
```

---

## 🚀 Setup & Execution Instructions

### Prerequisites
- Python 3.9+
- Node.js 18+

---

### 1. Backend Server Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```

2. Create and activate a Python virtual environment:
   ```bash
   python -m venv venv
   # On Windows:
   .\venv\Scripts\activate
   # On Linux/macOS:
   source venv/bin/activate
   ```

3. Install required packages:
   ```bash
   pip install -r requirements.txt
   ```

4. Create your local environment settings from the example:
   ```bash
   copy .env.example .env
   # Or on Unix: cp .env.example .env
   ```

5. Launch the FastAPI server:
   ```bash
   python -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
   ```
   *Note: If no display is detected (e.g. running on server VMs or headless boxes), the system will automatically engage **Mock Mode**, rendering a dynamic grid and bouncing indicators for previewing connections.*

---

### 2. Frontend Client Setup

1. Navigate to the frontend directory:
   ```bash
   cd ../frontend
   ```

2. Install Node dependencies:
   ```bash
   npm install
   ```

3. Start the Vite development server:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:3000](http://localhost:3000) in your web browser.

---

## 🔒 Security & Performance Features

1. **JWT Session Lifecycle**: Tokens expire in 15 minutes, refreshing requires re-submission of auth credentials via HTTPS POST.
2. **WebSocket Whitelisting**: Handshake checks query tokens against current signatures.
3. **Coordinate Validation**: Checks incoming mouse clicks to verify they reside strictly within `[0.0, 1.0]` boundaries to prevent viewport injection.
4. **Keystroke Whitelisting**: Blocks non-alphanumeric input triggers to prevent terminal escapes or malicious hotkeys from launching unauthorized tasks.
5. **Connection Limits**: Connection managers limit sessions per IP, protecting the socket engine from resource depletion (DoS).
6. **Temporal Sequencing**: A sequence buffer guarantees frame updates render chronologically without backward-flickering during lag spikes.
7. **Double Buffering**: Frames are rendered off-screen first and copied to the main viewport via `requestAnimationFrame` to prevent layout reflows and flicker.
8. **Memory Conservation**: Recycles `HTMLImageElement` allocations rather than generating new instances, minimizing JavaScript garbage collection sweeps.
