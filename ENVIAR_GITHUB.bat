@echo off
chcp 65001 >nul
title 3A Stream - Enviando para o GitHub (balok1904/3a-stream)
echo =============================================================
echo 🚀 ENVIANDO PROJETO 3A STREAM PARA O GITHUB...
echo Repositorio: https://github.com/balok1904/3a-stream.git
echo =============================================================
echo.
set GCM_INTERACTIVE=always
set GIT_TERMINAL_PROMPT=1
git remote remove origin 2>nul
git remote add origin https://github.com/balok1904/3a-stream.git
git branch -M main
git push -u origin main
echo.
echo =============================================================
echo ✅ Se o envio concluiu acima, ja pode fechar esta janela!
echo =============================================================
pause
