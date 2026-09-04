@echo off
echo ===================================================
echo     Starting Chrome with CDP Port 9222
echo ===================================================
echo.
echo Closing existing Chrome instances to avoid conflicts...
taskkill /F /IM chrome.exe /T > nul 2>&1
echo.
echo Opening Chrome in Debug Mode...
start chrome.exe --remote-debugging-port=9222 --restore-last-session
echo.
echo Chrome has been launched! Please login to Facebook in this window.
pause
