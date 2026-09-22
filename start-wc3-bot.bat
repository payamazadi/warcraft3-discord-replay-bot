@echo off
setlocal
where node >nul 2>&1 || set "PATH=%PATH%;C:\Program Files\nodejs"

rem stop any instances that are already running (start is idempotent)
taskkill /f /t /fi "WINDOWTITLE eq WC3 Stats Service*" >nul 2>&1
taskkill /f /t /fi "WINDOWTITLE eq WC3 Replay Bot*" >nul 2>&1
timeout /t 1 >nul

start "WC3 Stats Service" cmd /k "cd /d %~dp0service && node live-server.js"
timeout /t 2 >nul
start "WC3 Replay Bot" cmd /k "cd /d %~dp0 && node main.js"
echo WC3 stats service and Discord bot started (two windows opened).
timeout /t 3 >nul
