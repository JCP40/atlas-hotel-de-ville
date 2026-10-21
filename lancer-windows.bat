@echo off
chcp 65001 >nul
cd /d "%~dp0"
set MODE=%1
if "%MODE%"=="" set MODE=presentateur

rem --- Python ---
set PY=
where py >nul 2>nul && set PY=py
if "%PY%"=="" ( where python >nul 2>nul && set PY=python )
if "%PY%"=="" (
  echo Python est introuvable. Installez-le depuis https://www.python.org/downloads/
  echo en cochant « Add python.exe to PATH », puis relancez ce fichier.
  pause
  goto :eof
)

rem --- Serveur local (sans cache, pour que Chrome charge toujours la derniere version) ---
del .port 2>nul
start "Serveur de l'atlas (laisser ouvert)" /min %PY% serveur.py 8000
set PORT=8000
for /l %%i in (1,1,20) do (
  if exist .port goto :port
  timeout /t 1 >nul
)
:port
if exist .port set /p PORT=<.port
set URL=http://localhost:%PORT%/?mode=%MODE%

rem --- Chrome en priorite, sinon le navigateur par defaut ---
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
if defined CHROME (
  start "" "%CHROME%" "%URL%"
) else (
  echo Chrome est introuvable : ouverture dans le navigateur par defaut.
  start "" "%URL%"
)
echo.
echo Atlas ouvert : %URL%
echo Le serveur tourne dans la fenetre reduite « Serveur de l'atlas » : fermez-la pour arreter l'atlas.
timeout /t 8 >nul
