@echo off
rem Startar Schack Online. Oppna sedan http://schackonline.localhost i webblasaren (eller http://schackonline.localhost:3000).
cd /d "%~dp0"
set "PATH=%~dp0.tools\node;%PATH%"
node server.js
pause
