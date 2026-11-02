#!/bin/sh
# Двойной щелчок в Finder запускает репетитор (macOS). На Linux: ./start-mac.command
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Нужен Node.js: установите LTS-версию с https://nodejs.org/ru/download и запустите снова."
  (open https://nodejs.org/ru/download || xdg-open https://nodejs.org/ru/download) >/dev/null 2>&1
  read -r _; exit 1
fi
[ -d node_modules ] || { echo "Первый запуск: устанавливаю зависимости..."; npm install --no-audit --no-fund; }
node share.js
