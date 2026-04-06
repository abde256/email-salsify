@echo off
echo ============================================
echo   Publication sur GitHub
echo ============================================
echo.

cd /d "%~dp0"

where git >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERREUR] Git n'est pas installe.
    echo Telechargez-le sur : https://git-scm.com/download/win
    pause
    exit /b
)

if not exist ".git" (
    echo Initialisation du depot Git...
    git init
    git add .
    git commit -m "Initial commit - Email Salsify"
    echo.
    echo ============================================
    echo  Maintenant :
    echo  1. Allez sur github.com
    echo  2. Cliquez sur "New repository"
    echo  3. Nommez-le "email-salsify"
    echo  4. NE cochez PAS "Initialize this repository"
    echo  5. Cliquez "Create repository"
    echo  6. Copiez l'URL du depot (ex: https://github.com/VOTRE_NOM/email-salsify.git)
    echo  7. Revenez ici et appuyez sur une touche
    echo ============================================
    pause
    set /p REPO_URL="Collez l'URL GitHub ici : "
    git remote add origin %REPO_URL%
    git branch -M main
    git push -u origin main
) else (
    echo Mise a jour du depot existant...
    git add .
    git commit -m "Mise a jour - %DATE% %TIME%"
    git push
)

echo.
echo ✅ Code publie sur GitHub avec succes !
echo.
pause
