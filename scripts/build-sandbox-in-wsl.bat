@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>nul

REM ============================================================
REM  Build sandbox VM image using WSL2
REM  Prerequisites: WSL2 + Ubuntu installed (run setup-wsl.ps1 first)
REM ============================================================

set ROOT_DIR=%~dp0..
set ARCH=%~1
if "%ARCH%"=="" set ARCH=amd64

echo ============================================================
echo   Build sandbox VM image via WSL (arch: %ARCH%)
echo ============================================================
echo.

REM Check WSL is available
wsl --version >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: WSL is not installed.
    echo Please run as Admin first: powershell -ExecutionPolicy Bypass -File scripts\setup-wsl.ps1
    exit /b 1
)

REM Check Ubuntu is available
wsl -d Ubuntu-22.04 -- echo "ok" >nul 2>nul
if %ERRORLEVEL% neq 0 (
    REM Try default Ubuntu
    wsl -d Ubuntu -- echo "ok" >nul 2>nul
    if %ERRORLEVEL% neq 0 (
        echo ERROR: Ubuntu not found in WSL.
        echo Please run: wsl --install -d Ubuntu-22.04
        exit /b 1
    )
    set WSL_DISTRO=Ubuntu
) else (
    set WSL_DISTRO=Ubuntu-22.04
)

echo Using WSL distro: %WSL_DISTRO%
echo.

REM Convert Windows path to WSL path
for /f "usebackq tokens=*" %%i in (`wsl -d %WSL_DISTRO% -- wslpath -a "%ROOT_DIR%"`) do set WSL_ROOT=%%i

echo Project root (WSL): %WSL_ROOT%
echo.

REM Step 1: Install build dependencies in WSL
echo [1/4] Installing build dependencies in WSL...
wsl -d %WSL_DISTRO% -- bash -c "sudo apt-get update -qq && sudo apt-get install -y -qq qemu-utils parted e2fsprogs dosfstools kpartx rsync tar curl util-linux udev xz-utils 2>&1 | tail -3"
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to install dependencies.
    exit /b 1
)
echo       Done.
echo.

REM Step 2: Run the build script
echo [2/4] Building sandbox image (arch: %ARCH%)...
echo        This will download Alpine Linux and create the VM image.
echo        Please wait...
echo.

wsl -d %WSL_DISTRO% -- bash -c "cd '%WSL_ROOT%' && ARCHS=%ARCH% AGENT_RUNNER_BUILD=auto sudo -E sandbox/image/build.sh"
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Build failed.
    exit /b 1
)

REM Step 3: Fix file permissions (WSL root-owned files)
echo.
echo [3/4] Fixing file permissions...
wsl -d %WSL_DISTRO% -- bash -c "sudo chmod -R a+rw '%WSL_ROOT%/sandbox/image/out/' 2>/dev/null; true"

REM Step 4: Verify output
echo [4/4] Verifying output...
echo.

set OUTPUT_FILE=%ROOT_DIR%\sandbox\image\out\linux-%ARCH%.qcow2
if exist "%OUTPUT_FILE%" (
    echo   SUCCESS!
    echo   Output: sandbox\image\out\linux-%ARCH%.qcow2
    for %%A in ("%OUTPUT_FILE%") do echo   Size:   %%~zA bytes
    echo.
    echo Next step:
    echo   1) bash scripts/publish-sandbox-image.sh v0.1.5
    echo   2) python scripts\upload-sandbox-image.py --arch %ARCH% --version v0.1.5
) else (
    echo   WARNING: Expected output file not found: %OUTPUT_FILE%
    echo   Check the build output above for errors.
    dir "%ROOT_DIR%\sandbox\image\out\" 2>nul
)

echo.
endlocal
