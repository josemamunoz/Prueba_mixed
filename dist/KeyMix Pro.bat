@echo off
rem Abre KeyMix Pro en una ventana propia (sin barra de direcciones). No necesita servidor.
setlocal
set "APP=%~dp0KeyMix Pro.html"
set "URL=file:///%APP:\=/%"
for %%B in (msedge.exe chrome.exe) do (
  reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B" >nul 2>&1 && (start "" %%~nB --app="%URL%" & exit /b)
  reg query "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\%%B" >nul 2>&1 && (start "" %%~nB --app="%URL%" & exit /b)
)
rem Sin Edge ni Chrome: se abre con el navegador predeterminado.
start "" "%APP%"
