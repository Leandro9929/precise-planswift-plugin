@echo off
title Precise Page Renamer
cd /d "%~dp0"
set "HERE=%~dp0"
rem Windows Explorer runs a file opened inside a ZIP from a temporary "...zip\" folder.
if /i not "%HERE:.zip\=%"=="%HERE%" goto :inzip
where node >nul 2>nul
if errorlevel 1 goto :nonode
if not exist "node_modules\sharp\package.json" goto :nomodules
if /i not "%HERE:iCloudDrive=%"=="%HERE%" echo Note: this folder is synced by iCloud Drive. If the tool is slow or will not start, move the extracted folder to a local folder such as C:\Tools.
if /i not "%HERE:OneDrive=%"=="%HERE%" echo Note: this folder is synced by OneDrive. If the tool is slow or will not start, move the extracted folder to a local folder such as C:\Tools.
node server.js
if errorlevel 1 pause
exit /b

:inzip
echo This was started from inside the ZIP file, so Windows copied out only this one file.
echo.
echo 1. Close this window.
echo 2. Right-click the Precise_Page_Renamer ZIP file and choose "Extract All...".
echo 3. Extract it to a local folder, for example C:\Tools\Precise Page Renamer
echo 4. Open the extracted page-renamer folder and double-click "Start Precise Page Renamer.cmd".
echo.
pause
exit /b 1

:nonode
echo Node.js 20.9 or newer is required. Install the current LTS version from https://nodejs.org/
pause
exit /b 1

:nomodules
echo The node_modules folder is missing next to server.js.
echo Extract the whole ZIP with "Extract All..." and run this file from the extracted page-renamer folder.
pause
exit /b 1
