@echo off
setlocal EnableExtensions
set "STUDIO_ROOT=%~dp0..\.."
for %%I in ("%STUDIO_ROOT%") do set "STUDIO_ROOT=%%~fI"

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or is not on PATH.
  exit /b 1
)
for /f "usebackq delims=" %%V in (`node -p "process.versions.node"`) do set "NODE_VERSION=%%V"
for /f "tokens=1 delims=." %%M in ("%NODE_VERSION%") do set "NODE_MAJOR=%%M"
if not "%NODE_MAJOR%"=="24" (
  echo ERROR: Ash Atlas Appearance Studio requires Node 24.x. Found %NODE_VERSION%.
  exit /b 1
)

where pnpm >nul 2>nul
if errorlevel 1 (
  echo ERROR: pnpm 11.10.0 is required. Enable Corepack or install the repository package manager.
  exit /b 1
)
for /f "usebackq delims=" %%V in (`pnpm --version`) do set "PNPM_VERSION=%%V"
if not "%PNPM_VERSION%"=="11.10.0" (
  echo ERROR: Ash Atlas requires pnpm 11.10.0. Found %PNPM_VERSION%.
  exit /b 1
)

if not exist "%STUDIO_ROOT%\package.json" (
  echo ERROR: Could not resolve the Ash Atlas repository from this launcher.
  exit /b 1
)

pushd "%STUDIO_ROOT%"
for /f "usebackq delims=" %%V in (`git rev-parse --abbrev-ref HEAD`) do set "STUDIO_BRANCH=%%V"
for /f "usebackq delims=" %%V in (`git rev-parse HEAD`) do set "STUDIO_COMMIT=%%V"
set "APPEARANCE_STUDIO_EXPECTED_WORKTREE=%STUDIO_ROOT%"
set "APPEARANCE_STUDIO_EXPECTED_BRANCH=%STUDIO_BRANCH%"
set "APPEARANCE_STUDIO_EXPECTED_COMMIT=%STUDIO_COMMIT%"
set "STUDIO_OPEN_BROWSER=1"
echo Starting identity-verified Ash Atlas Appearance Studio.
echo Expected worktree: %STUDIO_ROOT%
echo Expected branch: %STUDIO_BRANCH%
echo Expected commit: %STUDIO_COMMIT%
echo This launcher starts only the local appearance authoring service.
call pnpm appearance:studio
set "STUDIO_EXIT=%ERRORLEVEL%"
popd
if not "%STUDIO_EXIT%"=="0" (
  echo.
  echo ERROR: Appearance Studio stopped with exit code %STUDIO_EXIT%.
)
exit /b %STUDIO_EXIT%
