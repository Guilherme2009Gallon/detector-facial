@echo off
chcp 65001 >nul
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py servidor.py
) else (
  python servidor.py
)
echo.
echo O servidor parou. Se apareceu um erro acima, confira se o Python esta instalado.
pause
