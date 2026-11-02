@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Репетитор по высшей математике
where node >nul 2>nul
if errorlevel 1 (
  echo Нужен Node.js. Сейчас откроется страница загрузки: установите LTS-версию и запустите этот файл снова.
  start https://nodejs.org/ru/download
  pause
  exit /b 1
)
if not exist node_modules (
  echo Первый запуск: устанавливаю зависимости...
  call npm install --no-audit --no-fund
)
node share.js
pause
