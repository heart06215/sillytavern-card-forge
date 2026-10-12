@echo off
chcp 65001 >nul
title 酒馆角色卡生成器 - 本地服务器兼容模式
cd /d "%~dp0"

rem 优先使用 python，其次 py 启动器；都没有则退回直接打开模式。
rem 本模式通过 http://127.0.0.1 访问页面，可解决浏览器对 file:// 页面的
rem 跨域限制（主要影响「AI 一键扩写」功能）。

where python >nul 2>nul
if %errorlevel%==0 (
    start "card-server" cmd /c "python -m http.server 18765 --bind 127.0.0.1"
    timeout /t 2 >nul
    start "" "http://127.0.0.1:18765/index.html"
    echo 本地服务器已启动：http://127.0.0.1:18765/index.html
    echo 停止方法：关闭弹出的 card-server 服务器窗口。
    pause
    exit /b
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "card-server" cmd /c "py -m http.server 18765 --bind 127.0.0.1"
    timeout /t 2 >nul
    start "" "http://127.0.0.1:18765/index.html"
    echo 本地服务器已启动：http://127.0.0.1:18765/index.html
    echo 停止方法：关闭弹出的 card-server 服务器窗口。
    pause
    exit /b
)

echo 未找到 Python，改用直接打开模式...
start "" "%~dp0index.html"
pause
