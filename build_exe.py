import subprocess
import sys
import os
import shutil

project_root = os.path.abspath(os.path.dirname(__file__))

def run_command(cmd, cwd=None):
    print(f"Running command: {cmd} in {cwd or 'current directory'}")
    result = subprocess.run(cmd, shell=True, cwd=cwd)
    if result.returncode != 0:
        print(f"Error executing command: {cmd}")
        sys.exit(result.returncode)

def main():
    # 1. Install pyinstaller
    print("Installing PyInstaller...")
    run_command("pip install pyinstaller")

    # 2. Check and compile frontend if not already compiled
    dist_dir = os.path.join(project_root, "frontend", "dist")
    if not os.path.isdir(dist_dir) or not os.listdir(dist_dir):
        print("Frontend dist not found. Compiling frontend...")
        run_command("npm install", cwd=os.path.join(project_root, "frontend"))
        run_command("npm run build", cwd=os.path.join(project_root, "frontend"))

    # 3. Create PyInstaller SPEC configuration
    spec_content = """# -*- mode: python ; coding: utf-8 -*-

block_cipher = None

a = Analysis(
    ['backend/main.py'],
    pathex=['backend'],
    binaries=[],
    datas=[
        ('frontend/dist', 'frontend/dist'),
        ('backend/.env.example', 'backend'),
    ],
    hiddenimports=[
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.auto',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'fastapi',
        'pydantic',
        'pyautogui',
        'mss',
        'psutil',
        'cryptography',
        'pyperclip',
        'pystray',
        'email.mime.multipart',
        'email.mime.text',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='vnc_server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
"""
    spec_path = os.path.join(project_root, "vnc_server.spec")
    with open(spec_path, "w", encoding="utf-8") as f:
        f.write(spec_content)
    print("Created vnc_server.spec configuration.")

    # 4. Run PyInstaller
    print("Compiling standalone executable via PyInstaller...")
    run_command("pyinstaller --clean vnc_server.spec")

    print("\n=======================================================")
    print("  Compilation Successful!")
    print(f"  Executable location: {os.path.join(project_root, 'dist', 'vnc_server.exe')}")
    print("=======================================================\n")

if __name__ == "__main__":
    main()
