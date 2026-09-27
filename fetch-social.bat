@echo off
chcp 65001 >nul
cd /d %~dp0
echo 开始采集 Instagram 和 X 动态（会弹出浏览器窗口自动操作，请勿关闭）...
call npm run fetch-social
echo.
echo 采集完成，正在提交并推送到 GitHub...
git add data/social.json
git commit -m "chore: refresh social data"
git pull --rebase origin main
git push
echo.
echo 全部完成！数据已更新到网站。
pause
