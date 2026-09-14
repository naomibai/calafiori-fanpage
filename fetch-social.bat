@echo off
chcp 65001 >nul
cd /d %~dp0
npm run fetch-social
pause
