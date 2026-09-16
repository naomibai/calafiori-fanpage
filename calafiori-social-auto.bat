@echo off
chcp 65001 >nul
cd /d %~dp0
echo ==== %date% %time% ==== >> "%USERPROFILE%\social-collect.log"
call npm run fetch-social >> "%USERPROFILE%\social-collect.log" 2>&1
git pull --rebase origin main >> "%USERPROFILE%\social-collect.log" 2>&1
git add data/social.json >> "%USERPROFILE%\social-collect.log" 2>&1
git commit -m "chore: refresh social data" >> "%USERPROFILE%\social-collect.log" 2>&1
git push >> "%USERPROFILE%\social-collect.log" 2>&1
