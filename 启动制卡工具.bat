@echo off
chcp 65001 >nul
title 酒馆卡锻造工坊
echo 正在用默认浏览器打开「酒馆卡锻造工坊」...
start "" "%~dp0index.html"
timeout /t 1 >nul
