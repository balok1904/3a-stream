@echo off
title 3A Stream Server - Painel Admin e Player Android
cd /d "%~dp0"
echo =============================================================
echo Iniciando Servidor 3A Stream na porta 3000...
echo Painel Admin: http://localhost:3000/admin
echo Player App:   http://localhost:3000/player
echo =============================================================
start http://localhost:3000/player?user=admin^&pass=123
node server.js
pause
