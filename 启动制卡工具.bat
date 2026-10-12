@echo off
chcp 65001 >nul
title 酒馆角色卡生成器
echo 正在用默认浏览器打开「酒馆角色卡生成器」...
start "" "%~dp0index.html"
timeout /t 1 >nul
