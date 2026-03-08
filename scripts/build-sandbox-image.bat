@echo off
setlocal enabledelayedexpansion

REM ============================================================
REM  Build sandbox VM image on Windows using Docker Desktop
REM  Usage: scripts\build-sandbox-image.bat [amd64|arm64|all]
REM ============================================================

set ROOT_DIR=%~dp0..
set IMAGE_NAME=lobsterai-sandbox-image-builder
set DOCKERFILE=%ROOT_DIR%\sandbox\image\Dockerfile
set BUILD_CONTEXT=%ROOT_DIR%\sandbox\image
set ARCHS=%~1

if "%ARCHS%"=="" set ARCHS=amd64

REM Check Docker is available
where docker >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: Docker not found. Please install Docker Desktop first.
    echo Download: https://www.docker.com/products/docker-desktop/
    exit /b 1
)

REM Check Docker is running
docker info >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Error: Docker is not running. Please start Docker Desktop.
    exit /b 1
)

echo ============================================================
echo  Building sandbox VM image (arch: %ARCHS%)
echo ============================================================
echo.

REM Build the Docker image for the builder environment
echo [1/3] Building Docker builder image...
docker build -f "%DOCKERFILE%" -t "%IMAGE_NAME%" "%BUILD_CONTEXT%"
if %ERRORLEVEL% neq 0 (
    echo Error: Failed to build Docker image.
    exit /b 1
)

REM Convert Windows path to Docker-compatible path
REM Docker Desktop on Windows can use /host_mnt/c/... or just the Windows path
set DOCKER_ROOT=%ROOT_DIR:\=/%

echo [2/3] Running image build inside Docker container...
echo        Architecture: %ARCHS%
echo        This may take several minutes...
echo.

docker run --rm --privileged ^
    -e ARCHS=%ARCHS% ^
    -e AGENT_RUNNER_BUILD=auto ^
    -e NO_SUDO=1 ^
    -e HOST_UID=0 ^
    -e HOST_GID=0 ^
    -v "%ROOT_DIR%:/workspace" ^
    -w /workspace ^
    "%IMAGE_NAME%" ^
    -lc "sandbox/image/build.sh"

if %ERRORLEVEL% neq 0 (
    echo.
    echo Error: Image build failed.
    exit /b 1
)

echo.
echo [3/3] Build complete!
echo.

REM Check output
if exist "%ROOT_DIR%\sandbox\image\out\linux-amd64.qcow2" (
    echo   Output: sandbox\image\out\linux-amd64.qcow2
    for %%A in ("%ROOT_DIR%\sandbox\image\out\linux-amd64.qcow2") do echo   Size:   %%~zA bytes
)
if exist "%ROOT_DIR%\sandbox\image\out\linux-arm64.qcow2" (
    echo   Output: sandbox\image\out\linux-arm64.qcow2
    for %%A in ("%ROOT_DIR%\sandbox\image\out\linux-arm64.qcow2") do echo   Size:   %%~zA bytes
)

echo.
echo Next step:
echo   1) Package files: bash scripts/publish-sandbox-image.sh v0.1.5
echo   2) Upload CDN:   python scripts\upload-sandbox-image.py --arch %ARCHS% --version v0.1.5
echo.

endlocal
