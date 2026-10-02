@echo off
rem Verify the real CLI and native addon before selecting a Node runtime.
setlocal
set "ROOT=%~dp0.."
set "LIVE_SHARE_RUNTIME="
if defined CODEX_LIVE_SHARE_NODE goto explicit
if defined CODEX_MCP_NODE_PATH call :probe "%CODEX_MCP_NODE_PATH%"
if defined LIVE_SHARE_RUNTIME goto launch
for /f "delims=" %%N in ('where node 2^>nul') do if not defined LIVE_SHARE_RUNTIME call :probe "%%N"
if defined LIVE_SHARE_RUNTIME goto launch
echo Live Share needs Node.js 22 or newer that can load its bundled WebRTC addon. Set CODEX_LIVE_SHARE_NODE to a compatible executable. 1>&2
exit /b 127

:explicit
"%CODEX_LIVE_SHARE_NODE%" "%ROOT%\bin\check-runtime.mjs" >nul
if errorlevel 1 exit /b %ERRORLEVEL%
set "LIVE_SHARE_RUNTIME=%CODEX_LIVE_SHARE_NODE%"

:launch
"%LIVE_SHARE_RUNTIME%" "%ROOT%\dist\cli.js" %*
exit /b %ERRORLEVEL%

:probe
"%~1" "%ROOT%\bin\check-runtime.mjs" >nul 2>nul
if not errorlevel 1 set "LIVE_SHARE_RUNTIME=%~1"
exit /b 0
