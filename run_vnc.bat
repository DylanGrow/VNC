@echo off
title Antigravity VNC Launcher
setlocal enabledelayedexpansion

:: Colors
set "ESC="
set "GREEN=%ESC%[92m"
set "YELLOW=%ESC%[93m"
set "BLUE=%ESC%[94m"
set "RED=%ESC%[91m"
set "RESET=%ESC%[0m"

echo %BLUE%================================================================%RESET%
echo   %GREEN%Antigravity VNC Remote Desktop Control Panel & Launcher%RESET%
echo %BLUE%================================================================%RESET%
echo.

:: Check Python installation
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo %RED%Error: Python is not installed or not in your PATH.%RESET%
    echo Please install Python 3.10+ to run the VNC server.
    echo.
    pause
    exit /b 1
)

:: Ensure .env file exists in the backend
if not exist "backend\.env" (
    echo %YELLOW%Configuring backend environment (.env)...%RESET%
    copy "backend\.env.example" "backend\.env" >nul
    
    :: Generate secure random key and password
    for /f "tokens=*" %%i in ('python -c "import secrets; print(secrets.token_hex(32))"') do set "RAND_SECRET=%%i"
    for /f "tokens=*" %%i in ('python -c "import secrets; print('vnc_' + secrets.token_urlsafe(12))"') do set "RAND_PASS=%%i"
    for /f "tokens=*" %%i in ('python -c "import base64,os; print(base64.b64encode(os.urandom(32)).decode('utf-8'))"') do set "RAND_AUDIT=%%i"

    :: Write configuration values
    python -c "
with open('backend/.env', 'r') as f:
    text = f.read()
text = text.replace('change_me_to_a_strong_password', '%RAND_PASS%')
text = text.replace('change_this_to_a_very_secure_random_key_at_least_32_bytes', '%RAND_SECRET%')
text = text.replace('AUDIT_LOG_KEY=', 'AUDIT_LOG_KEY=%RAND_AUDIT%')
with open('backend/.env', 'w') as f:
    f.write(text)
"
    echo %GREEN%Created backend\.env file with secure generated password and signing keys.%RESET%
    echo.
)

:: Read existing credentials from .env
for /f "usebackq delims== tokens=1,2" %%A in ("backend\.env") do (
    if "%%A"=="SECURE_PASSWORD" set "VNC_PASS=%%B"
    if "%%A"=="PORT" set "VNC_PORT=%%B"
)
if "%VNC_PORT%"=="" set "VNC_PORT=8000"

:menu
echo %BLUE%Please select an execution mode:%RESET%
echo.
echo   [1] Run VNC Server Locally (Fastest, uses Python + Pre-built Web Console)
echo   [2] Run VNC Server in Docker (Production Mode with Nginx Reverse Proxy)
echo   [3] Build/Recompile Web Frontend Assets (Vite + TypeScript)
echo   [4] Compile into Standalone Windows .exe (No Python installation required)
echo   [5] Build Android Companion App (Gradle/Kotlin, requires Java JDK)
echo   [6] View Server Connection Info (Password & URL)
echo   [7] Exit Control Panel
echo.
set /p "choice=Enter option [1-7]: "

if "%choice%"=="1" goto run_local
if "%choice%"=="2" goto run_docker
if "%choice%"=="3" goto build_frontend
if "%choice%"=="4" goto compile_exe
if "%choice%"=="5" goto build_android
if "%choice%"=="6" goto view_info
if "%choice%"=="7" exit /b 0
echo %RED%Invalid option. Please choose between 1 and 7.%RESET%
echo.
goto menu

:run_local
echo.
echo %YELLOW%Installing Python backend dependencies...%RESET%
python -m pip install -r backend/requirements.txt
if %errorlevel% neq 0 (
    echo %RED%Failed to install requirements. Please check your network connection.%RESET%
    goto menu
)
echo.
echo %GREEN%Starting Antigravity VNC Server locally...%RESET%
echo URL: http://localhost:%VNC_PORT%
echo Password: %GREEN%%VNC_PASS%%RESET%
echo %YELLOW%Press Ctrl+C to stop the server.%RESET%
echo.
cd backend
python main.py
cd ..
goto menu

:run_docker
echo.
docker-compose --version >nul 2>&1
if %errorlevel% neq 0 (
    echo %RED%Error: Docker/Docker-Compose is not running or installed.%RESET%
    echo Please install Docker Desktop to use containerized mode.
    echo.
    goto menu
)
echo %YELLOW%Starting containerized services via docker-compose...%RESET%
docker-compose up --build
goto menu

:build_frontend
echo.
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo %RED%Error: Node.js/npm is not installed.%RESET%
    echo Please install Node.js (v18+) to compile the frontend.
    echo.
    goto menu
)
echo %YELLOW%Installing NPM dependencies...%RESET%
cd frontend
call npm install
echo %YELLOW%Compiling Vite production bundle...%RESET%
call npm run build
cd ..
echo.
echo %GREEN%Frontend compiled successfully to frontend\dist\%RESET%
echo.
goto menu

:view_info
echo.
echo %BLUE%================================================================%RESET%
echo   %GREEN%Antigravity VNC Server Connection Details%RESET%
echo %BLUE%================================================================%RESET%
echo   Local Address:      http://localhost:%VNC_PORT%
echo   Secure Password:    %GREEN%%VNC_PASS%%RESET%
echo   Environment Mode:   development
echo %BLUE%================================================================%RESET%
echo.
goto menu

:compile_exe
echo.
echo %YELLOW%Compiling FastAPI backend into a standalone vnc_server.exe...%RESET%
python build_exe.py
echo.
goto menu

:build_android
echo.
echo %YELLOW%Building Android Companion App (Gradle)...%RESET%
if not exist "android\gradlew" (
    echo %RED%Error: Gradle wrapper not found in android directory.%RESET%
    goto menu
)
cd android
call gradlew.bat assembleDebug --no-daemon
if %errorlevel% neq 0 (
    echo %RED%Android build failed. Please make sure Android SDK and Java JDK are configured.%RESET%
    cd ..
    goto menu
)
cd ..
echo.
echo %GREEN%Android Debug APK built successfully!%RESET%
echo Location: android\app\build\outputs\apk\debug\app-debug.apk
echo.
goto menu
