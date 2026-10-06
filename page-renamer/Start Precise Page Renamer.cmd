@echo off
title Precise Page Renamer
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20.9 or newer is required. Install the current LTS version from https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\sharp" (
  echo The node_modules folder is missing. Extract the whole ZIP, keeping node_modules next to server.js.
  pause
  exit /b 1
)
node server.js
if errorlevel 1 pause
