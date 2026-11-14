@echo off
rem Run in a visible window for debugging (close the window to stop)
chcp 65001 >nul
cd /d "%~dp0"
node main.mjs
pause
