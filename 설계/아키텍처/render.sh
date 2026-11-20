#!/bin/sh
# HTML → PNG (2배 해상도). 인자 없으면 세 장 모두
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
DIR="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
[ $# -eq 0 ] && set -- 전체_시스템_아키텍처 AI_서비스_아키텍처 인프라_및_배포_아키텍처
for f in "$@"; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=1800,1100 --virtual-time-budget=8000 \
    --screenshot="$DIR/$f.png" "file:///$DIR/$f.html" 2>/dev/null
  echo "$f.png"
done
