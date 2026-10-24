@echo off
rem Install or update Pazuzu: pull, install production deps, build.
rem Also works right after `git clone` (the pull is a no-op there).
cd /d "%~dp0"

git pull || (echo git pull failed & exit /b 1)
call npm install --omit=dev || (echo npm install failed & exit /b 1)
call npm run build || (echo npm run build failed & exit /b 1)

echo.
echo Done. Restart the server to apply:
echo   node .output\server\index.mjs
echo.
pause
