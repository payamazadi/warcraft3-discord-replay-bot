@echo off
taskkill /f /t /fi "WINDOWTITLE eq WC3 Stats Service*" >nul 2>&1
taskkill /f /t /fi "WINDOWTITLE eq WC3 Replay Bot*" >nul 2>&1
echo WC3 stats service and Discord bot stopped.
timeout /t 3 >nul
