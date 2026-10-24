# KS 앱스토어

직접 만든 앱을 쪽지 돌리듯 친구·가족과 나눠 쓰는 작은 앱스토어입니다.

- 주소: https://aznail1980-ctrl.github.io/ks-app-store/
- 화면: GitHub Pages / 로그인·데이터: Firebase(ks-app-store) Authentication + Firestore

## 파일 구성

| 파일 | 하는 일 |
|---|---|
| `index.html` | 앱 전체 (화면, 동작). 맨 위 `:root` 블록에서 색·글꼴·간격을 바꿀 수 있어요 |
| `assets/illust/` | 직접 그린 일러스트 (SVG). 고친 뒤에는 `index.html`의 `ASSET_V` 값을 바꿔 주세요 |
| `assets/brand/` | 로고, 브라우저 탭 아이콘, 홈 화면 아이콘 원본 |
| `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` | 홈 화면 아이콘 (`assets/brand/app-icon.svg`에서 만든 PNG) |
| `manifest.json` | 홈 화면에 추가했을 때의 이름·아이콘 |
| `firestore.rules` | 보안 규칙. **진짜 보안은 여기서 지켜요** |
| `redirect/` | 예전 주소(ks-app-store.web.app)에 남겨 둔 '이사 안내' 페이지 |

## 고친 내용을 사이트에 반영하기

```bash
git add -A
git commit -m "무엇을 바꿨는지"
git push
```

push 하고 1~2분 뒤 사이트에 반영돼요.

## 관리자가 한 번 해 둘 일

1. **보안 규칙 반영**: Firebase 콘솔 → Firestore Database → 규칙 탭에 `firestore.rules` 내용을 붙여 넣고 게시
2. **AI 연결**: 앱에 관리자로 로그인 → 관리 → 설정에서 Gemini API 키 입력.
   키는 Google Cloud 콘솔에서 사용처를 `https://aznail1980-ctrl.github.io/*` 로 제한해 두세요.
3. **로그인 허용 주소**: Firebase 콘솔 → Authentication → 설정 → 승인된 도메인에 `aznail1980-ctrl.github.io` 추가

## 화면 주소

- `#/` 홈 · `#/search` 찾기 · `#/me` 내 정보 · `#/admin` 관리
- `#/app/앱ID` 특정 앱 상세 (이 주소를 친구에게 보내면 그 앱이 바로 열려요)
