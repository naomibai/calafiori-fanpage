@echo off
chcp 65001 >nul
cd /d %~dp0
echo 使用你日常 Edge 的登录态采集（请先关闭所有 Edge 窗口）...
set USE_REAL_PROFILE=1
npm run fetch-social
pause
