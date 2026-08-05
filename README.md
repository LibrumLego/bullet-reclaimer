# 탄환 회수자

> 한 발이면 충분하다. 다시 주울 수만 있다면.

시간을 멈춰 단 한 발의 도탄 궤적을 설계하고, 발사 후 비무장 상태로 총알을 회수하는 브라우저 액션 게임입니다.

## 개발 환경

- Node.js 24 이상
- Vite
- TypeScript
- Phaser

PowerShell의 실행 정책으로 `npm` 실행이 차단되는 환경에서는 `npm.cmd`를 사용합니다.

```powershell
npm.cmd install
npm.cmd run dev
```

프로덕션 빌드:

```powershell
npm.cmd run build
npm.cmd run preview
```

## 기본 조작안

- 이동: `WASD`
- 조준 및 시간 정지: 마우스 버튼 길게 누르기
- 발사: 마우스 버튼 놓기
- 재시작: `R`

## 핵심 규칙

- 플레이어와 적은 총알 한 발에 사망합니다.
- 총알은 단 한 발이며, 발사 후 직접 회수해야 합니다.
- 조준 중에는 시간이 정지하고 예상 도탄 궤적이 표시됩니다.
- 발사 순간 시간이 다시 흐릅니다.
- 자신의 총알에 맞아도 사망합니다.

## 제출 준비

- `docs/ai-usage-log.md`: AI 활용 및 프롬프트 기록
- `docs/submission-checklist.md`: 공모전 제출물 체크리스트
- `.github/workflows/deploy-pages.yml`: GitHub Pages 자동 배포

