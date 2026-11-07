# ilchon 작업 안내

직접 만나 QR을 서로 찍은 사람하고만 비트코인을 P2P로 거래하는 웹앱이다. 조건은 반대편 일촌에게만 보인다. 서버 없이 Nostr 중계 서버 위의 Marmot(MLS)으로 통신한다.

지금 단계: 해커톤(bitcoin++ Seoul 2026) 이후, 기획자의 친구들이 실제로 쓸 수 있게 지금 기능을 다듬는 중이다. 새 기능보다 지금 흐름이 막힘없이 도는 것이 먼저다.

## 어디에 무엇이 있나

| 무엇 | 어디 | 비고 |
|---|---|---|
| 무엇을 왜 만드는가, 확정된 결정 | `p2p-거래-기획.md` | 정본. 기획자가 확정한 결정은 여기에 기록한다 |
| 모듈 경계와 타입 | `src/contracts.ts` | 코드 규약의 정본. 첫머리에 모듈 지도가 있다 |
| 공개 설명, 알려진 한계 | `README.md` | 영어. 프라이버시 주장이 바뀌면 여기 표와 한계 목록도 고친다 |
| 해커톤 발표 자료 | `docs/` | 피치, 시연 대본, Marmot 근거 |
| 주변 생태계 조사 | `리서치-페디와-생태계.md` | Fedi, Cashu, Marmot 현황 (2026-11-07) |
| 해커톤 당시 계획 | `구현-계획.md` | 지난 문서. 보존만 한다 |
| 할 일 | GitHub 이슈 https://github.com/dongguri-jun/ilchon/issues | 보드(Project "ilchon 개발")는 비공개, 이슈와 PR은 공개 |

## 명령

Node 24, pnpm 11.9.0(`package.json`의 `packageManager`)을 쓴다. 의존성 빌드 허용(`allowBuilds`)은 `pnpm-workspace.yaml`에 있다.

```bash
pnpm i            # 설치
pnpm dev          # 개발 서버 http://localhost:5173
pnpm check        # 타입 검사 + 맞춰보기 검사 + 키 잠금 검사 (네트워크 불필요, CI와 같음)
pnpm build        # 배포용 빌드 (dist/)
pnpm e2e          # 실제 중계 서버 위 세 사용자 시나리오 (네트워크 필요, CI에서는 안 돌림)
pnpm exec tsx scripts/smoke-marmot.ts   # Marmot 그룹 생성과 메시지 교환만 확인
```

## 변경 후 확인

- 모든 변경: `pnpm check`. PR마다 GitHub Actions(`.github/workflows/check.yml`)가 `pnpm check`와 `pnpm build`를 돌린다.
- 엔진, 맞춰보기, Marmot 전송을 바꿨으면 `pnpm e2e`까지 돌린다.
- 화면을 바꿨으면 개발 서버에서 직접 본다.
  - 같은 브라우저에서 `?p=a`, `?p=b`처럼 이름(영문·숫자·`_`·`-`, 24자 이하)을 달리하면 사람마다 키와 저장소가 따로 생긴다. `?demo=1`은 맞춰보기 간격을 실시간으로, `?demo=0`은 24시간으로 둔다.
  - 가짜 통신은 없다. 개발 서버에서도 실제 중계 서버에 붙고, https나 localhost에서만 돈다(WebCrypto).
  - 내장 브라우저는 카메라가 막혀 있으므로 연결 화면의 "코드 복사"와 "코드 붙여넣기"로 연결한다. 코드는 30초마다 바뀐다.
- 화면 문구는 `registerStrings`를 부르는 파일에 한국어와 영어가 함께 있다: `src/screens/*/strings.ts`, `src/screens/shell/install-strings.ts`, `src/ui/strings.ts`. 둘 다 고친다.

## 지켜야 할 것

- **서버를 두지 않는다.** 앱 코드는 접속하는 모든 브라우저에 그대로 내려간다. 그러니 API 키, `.env` 같은 비밀값을 앱 코드나 저장소에 넣지 않는다. 비밀값이 필요한 기능은 별도 서버가 필요하므로 먼저 기획자와 정한다.
- **앱 전용 키를 쓴다.** 사용자의 다른 Nostr 신원(예: Fedi의 NIP-07 키)과 거래 관계를 연결하지 않는다.
- **맞지 않는 일촌에게 조건이 새지 않아야 한다.** 이 약속을 건드리는 변경은 `scripts/check-match.ts`나 `scripts/e2e.ts`에 그 경우를 추가한다.
- **`@internet-privacy/marmot-ts`는 정확한 버전(`0.9.0`)으로 고정되어 있다.** Marmot 규격이 자주 바뀌므로, 올릴 때는 따로 작업하고 `pnpm e2e`로 확인한다.
- `src/contracts.ts`의 시그니처를 바꾸면 모든 사용처를 함께 고친다.

## 일하는 방식

- 할 일은 GitHub 이슈로 만든다. PR 본문에 `Closes #번호`를 적으면 머지될 때 이슈가 닫힌다.
- `main`에서 바로 작업하지 않고 브랜치를 만든다. 커밋과 푸시는 기획자가 요청할 때 한다.
- 기획자가 방향이나 원칙을 확정하면 `p2p-거래-기획.md`의 해당 절에 날짜와 함께 기록한다. 같은 내용을 여러 문서에 옮겨 적지 않는다.

## 배포

배포는 외부 공개이므로 기획자가 요청할 때만 한다.

```bash
pnpm build
npx wrangler pages deploy dist --project-name ilchon --branch main
```

- Cloudflare Pages 프로젝트 `ilchon`. 주소는 https://ilchon.org 이고, https://ilchon.dongguri.org 도 같은 프로젝트를 가리킨다.
- 배포 뒤에는 휴대폰 크기 화면에서 첫 화면, 중계 서버 연결, 시세 표시를 확인한다.
