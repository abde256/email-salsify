@echo off
echo ============================================
echo   Email Salsify - Demarrage du serveur
echo ============================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERREUR] Node.js n'est pas installe.
    echo Telechargez-le sur : https://nodejs.org
    pause
    exit /b
)

if not exist node_modules (
    echo Installation des dependances...
    npm install
    echo.
)

echo Demarrage du serveur...
echo Ouvrez votre navigateur sur : http://localhost:3001
echo.
echo Appuyez sur Ctrl+C pour arreter le serveur.
echo.
start "" http://localhost:3001
node server.js
pause
