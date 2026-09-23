@echo off
rem vysu, the Windows launcher: the engine is TypeScript run as it is, on Node (or on bun when VYSU_RUNTIME=bun).
if /i "%VYSU_RUNTIME%"=="bun" (
  bun "%~dp0..\src\cli.ts" %*
) else (
  node --experimental-strip-types --disable-warning=ExperimentalWarning "%~dp0..\src\cli.ts" %*
)
exit /b %ERRORLEVEL%
