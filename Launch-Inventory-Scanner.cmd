@echo off
setlocal
title Inventory Scanner - Expo Launcher

cd /d "C:\Users\Asus\Downloads\Inventory-Scanner"
if errorlevel 1 (
    echo.
    echo Could not open the project folder:
    echo C:\Users\Asus\Downloads\Inventory-Scanner
    echo.
    pause
    exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
    echo.
    echo pnpm was not found in PATH.
    echo Open PowerShell and confirm that "pnpm --version" works.
    echo.
    pause
    exit /b 1
)

call pnpm launch
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo pnpm launch exited with code %EXIT_CODE%.
    pause
)

endlocal
exit /b %EXIT_CODE%
