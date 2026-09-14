@echo off
setlocal
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Python environment not found. See README.md for setup.
  exit /b 2
)
"%~dp0.venv\Scripts\python.exe" "%~dp0image_to_deck.py" %*
exit /b %ERRORLEVEL%
