#!/bin/bash
# ════════════════════════════════════════════════════════════
#  KS 앱스토어 — 로그인 앱 '한 번만 로그인' 기록
#  Finder에서 이 파일을 더블클릭하면 됩니다. 터미널이 어느 폴더에 있든 상관없어요.
#  하는 일: 이 파일이 있는 scripts 폴더로 이동 → (처음만) 준비물 설치 → 로그인 기록 창 열기
# ════════════════════════════════════════════════════════════
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"   # node·gh 를 찾을 수 있게
cd "$(dirname "$0")" || exit 1
clear
echo "KS 앱스토어 — 로그인 기록을 시작해요."
echo ""

if ! command -v node > /dev/null; then echo "node 프로그램이 없어요. Claude에게 알려 주세요."; read -r -p "Enter를 누르면 닫혀요."; exit 1; fi
if ! command -v gh > /dev/null; then echo "gh 프로그램이 없어요. Claude에게 알려 주세요."; read -r -p "Enter를 누르면 닫혀요."; exit 1; fi

if [ ! -d node_modules/playwright ]; then
  echo "처음이라 준비물을 설치해요 (1~2분)..."
  npm install --no-audit --no-fund --loglevel=error || { echo "설치에 실패했어요. 인터넷 연결을 확인해 주세요."; read -r -p "Enter를 누르면 닫혀요."; exit 1; }
  xattr -w com.dropbox.ignored 1 node_modules 2>/dev/null   # 설치한 준비물은 Dropbox에 올리지 않음
fi
npx playwright install chromium > /dev/null 2>&1

echo "곧 브라우저 창이 열려요. 창 위쪽 노란 띠의 안내를 따라 주세요."
echo ""
node record-logins.mjs
echo ""
read -r -p "끝났어요. Enter를 누르면 이 창이 닫혀요."
