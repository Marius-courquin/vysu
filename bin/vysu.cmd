@echo off
setlocal
rem vysu, the Windows launcher: bin\vysu.mjs checks Node and the engine's dependencies, then loads the
rem TypeScript engine as it is, on Node (or on bun when VYSU_RUNTIME=bun).
if defined HTTPS_PROXY set NODE_USE_ENV_PROXY=1
if defined HTTP_PROXY set NODE_USE_ENV_PROXY=1
if /i "%VYSU_RUNTIME%"=="bun" (
  bun "%~dp0vysu.mjs" %*
) else (
  node "%~dp0vysu.mjs" %*
)
exit /b %ERRORLEVEL%
