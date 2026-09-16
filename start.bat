@echo off
chcp 65001 >nul
setlocal EnableExtensions
title 伯乐招聘系统 一键启动
set "APP_SERVER=http://127.0.0.1:4700"
cd /d "%~dp0"

echo ============================================
echo     伯乐招聘系统  ·  一键启动
echo ============================================
echo.

rem ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。请先安装 Node.js 18 或更高版本。
  echo        下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)
echo [1/4] Node.js    : OK
node -v

rem ---------- 2. 读取 AI 模型直连配置（llm.env，含密钥不入库） ----------
set "HR_LLM_BASE="
if exist "%~dp0llm.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0llm.env") do set "%%a=%%b"
)
if defined HR_LLM_BASE (
  echo [2/4] AI 模型   : %HR_LLM_MODEL%  （直连 %HR_LLM_BASE%）
) else (
  echo [2/4] AI 模型   : 未配置，离线启发式运行
)

rem ---------- 3. 判断服务是否已运行 ----------
curl.exe -s --max-time 3 -o NUL "http://127.0.0.1:4700/health" 2>nul
if not errorlevel 1 (
  echo [3/4] 服务      : 已在运行（端口 4700）
  echo [4/4] 正在打开浏览器 ...
  start "" "%APP_SERVER%"
  echo.
  echo 服务地址: %APP_SERVER%
  echo 登录账号: wang    密码: boss123
  echo AI 模型: 直连 DeepSeek（详见 llm.env）
  echo 关闭本窗口不影响服务。停止服务请关闭「伯乐招聘系统 - 后端服务」窗口。
  echo.
  pause
  exit /b 0
)

rem ---------- 4. 未运行则启动后端（继承上方 AI 直连环境变量） ----------
echo [3/4] 服务      : 启动中 ...
start "伯乐招聘系统 - 后端服务" /min /d "%~dp0" cmd /k "chcp 65001 >nul && node framework/server.js"

rem ---------- 5. 等待就绪 ----------
echo [4/4] 等待服务就绪并打开浏览器 ...
set /a tries=0
:waitloop
ping -n 2 127.0.0.1 >nul
set /a tries+=1
curl.exe -s --max-time 3 -o NUL "http://127.0.0.1:4700/health" 2>nul
if not errorlevel 1 goto ready
if %tries% geq 20 goto fail
goto waitloop

:ready
echo.
echo 启动成功！
echo 服务地址: %APP_SERVER%
echo 登录账号: wang    密码: boss123
echo AI 模型: 直连 DeepSeek（详见 llm.env）
start "" "%APP_SERVER%"
echo 关闭本窗口不影响服务。停止服务请关闭「伯乐招聘系统 - 后端服务」窗口。
echo.
pause
exit /b 0

:fail
echo.
echo [错误] 服务未能就绪（等待超时）。
echo 可能原因: 端口 4700 被占用、Node 环境异常、或防火墙拦截了本地端口。
echo 请查看任务栏「伯乐招聘系统 - 后端服务」窗口中的报错信息。
echo.
pause
exit /b 1