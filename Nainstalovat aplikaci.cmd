@echo off
rem MakerBeater - vytvori zastupce aplikace (plocha, nabidka Start, tato slozka).
rem Po presunuti slozky projektu staci spustit znovu.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\nainstalovat.ps1"
if errorlevel 1 echo. & echo Instalace se nepovedla - viz chyba vyse.
echo.
pause
