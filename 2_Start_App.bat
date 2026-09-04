@echo off
echo ===================================================
echo     FB Magic Engine - Starting Server
echo ===================================================
echo.

IF NOT EXIST "node_modules\" (
    echo Installing dependencies for the first time...
    echo This might take a minute.
    call npm install
)

echo.
echo Starting the Application...
call npm run dev
pause
