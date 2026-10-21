@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Borne des portes ouvertes : serveur local + Chrome en plein ecran (kiosque).
rem Pour quitter le mode kiosque : Alt+F4.
set PY=
where py >nul 2>nul && set PY=py
if "%PY%"=="" ( where python >nul 2>nul && set PY=python )
del .port 2>nul
start "Serveur de l'atlas (laisser ouvert)" /min %PY% serveur.py 8000
set PORT=8000
for /l %%i in (1,1,20) do (
  if exist .port goto :port
  timeout /t 1 >nul
)
:port
if exist .port set /p PORT=<.port
set URL=http://localhost:%PORT%/?mode=borne
set CHROME=
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe
if defined CHROME (
  start "" "%CHROME%" --kiosk "%URL%"
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --kiosk "%URL%" --edge-kiosk-type=fullscreen
) else (
  start "" "%URL%"
)
