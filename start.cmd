@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment not found. See README.md for setup.
  exit /b 2
)
".venv\Scripts\python.exe" "server.py"
