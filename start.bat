@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ================================================
echo   OPC Studio
echo   Backend:  http://localhost:3100
echo   Frontend: http://localhost:5173
echo ================================================

echo Starting backend...
start "OPC Backend" cmd /k "cd /d %~dp0 && npx tsx apps\server\src\index.ts"

echo Waiting for backend to be ready...
powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { if ((Invoke-WebRequest -Uri 'http://localhost:3100/api/health' -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200) { exit 0 } } catch {} ; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 echo   Backend health check timed out, continuing anyway...

echo Starting frontend...
start "OPC Frontend" cmd /k "cd /d %~dp0 && pnpm --filter @opc/web dev"

echo Waiting for frontend to be ready...
powershell -NoProfile -Command "for ($i=0; $i -lt 30; $i++) { try { if ((Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200) { exit 0 } } catch {} ; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 echo   Frontend health check timed out, continuing anyway...

start "" http://localhost:5173

echo.
echo   Opened in browser.
pause
