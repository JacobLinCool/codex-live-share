@echo off
rem Runs the Live Share CLI on a Node runtime, preferring the one Codex ships.
setlocal
set "ROOT=%~dp0.."
if defined CODEX_LIVE_SHARE_NODE if exist "%CODEX_LIVE_SHARE_NODE%" ( "%CODEX_LIVE_SHARE_NODE%" "%ROOT%\dist\cli.js" %* & exit /b %ERRORLEVEL% )
if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" ( "%CODEX_MCP_NODE_PATH%" "%ROOT%\dist\cli.js" %* & exit /b %ERRORLEVEL% )
where node >nul 2>nul && ( node "%ROOT%\dist\cli.js" %* & exit /b %ERRORLEVEL% )
echo Live Share could not find a Node runtime. Update Codex, or install Node.js 22 or newer. 1>&2
exit /b 127
