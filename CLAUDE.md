# mygrid

Instagram 피드를 미리 배치해 보는 모바일 웹앱(PWA). 사진을 올리거나 인스타 프로필 캡처를 잘라 3열 그리드로 보여주고, 순서 변경·삭제를 한다. 서버 저장소 없이 **모든 데이터는 기기 안(IndexedDB, localStorage)에만** 있다.

## 소통

- 사용자에게 하는 설명·보고·질문은 **항상 한국어**로 한다. 코드, 식별자, 커밋 메시지, 테스트 이름은 영어.

## 명령어

| 목적 | 명령 |
|---|---|
| 개발 서버 | `npm run dev` |
| 프로덕션 빌드 | `npm run build` |
| 타입 체크 | `npx tsc --noEmit -p .` |
| 단위 테스트 (Vitest + fake-indexeddb) | `npm test` |
| E2E 테스트 (Playwright, iPhone WebKit + Android Chromium) | `npm run test:e2e` |

E2E는 포트 3100에서 `next dev`를 자동으로 띄운다(이미 떠 있으면 재사용). 브라우저가 없으면 `npx playwright install webkit chromium`.

## 구조

- `app/page.tsx` — 스플래시. 서비스워커 등록 후 `/home`으로 이동.
- `app/home/page.tsx` — 앱 본체(온보딩 2단계 → 피드, 사진 편집기, 뷰어, 길게 눌러 선택/드래그 정렬, 프로필 캡처 분할).
- `lib/draft-store.ts` — 피드 사진 저장소(IndexedDB `mygrid-export`). 테스트: `lib/draft-store.test.ts`.
- `lib/instagram-export.ts` — Instagram 내보내기 zip 파싱(현재 화면에서 미사용).
- `app/api/image/route.ts` — Instagram CDN 이미지 프록시(허용 호스트만).
- `public/sw.js` — 셸 캐시. `/_next/`·RSC 요청은 절대 캐시하지 않는다. 캐시 구조를 바꾸면 `CACHE_NAME` 버전을 올린다.
- `e2e/` — Playwright 시나리오와 헬퍼(`helpers.ts`: PNG 생성, 사진 추가, 이미지 로드/IndexedDB 저장 검증).

## 개발 방식

- **TDD로 진행한다.** 버그 수정·기능 추가 모두 실패하는 테스트를 먼저 쓰고(red), 통과시키고(green), 정리한다.
  - 저장소·순수 로직 → `lib/*.test.ts` 단위 테스트
  - 사용자 흐름·UX → `e2e/*.spec.ts`. 사용자가 실제로 하는 동작(탭, 길게 누르기, 재시작=`page.reload()`)으로 쓰고, "앱을 껐다 켜도 유지되는지"까지 확인한다.
- 버그는 원인부터 찾는다. 재현 테스트 없이 추측으로 고치지 않는다. 재현이 안 되면 그렇다고 말한다.
- 완료라고 말하기 전에 `npx tsc --noEmit -p .`, `npm test`, `npm run test:e2e`를 돌려 통과를 확인한다. 화면 변경은 `npm run build`도.
- E2E 셀렉터는 역할/접근성 이름(`getByRole`, `getByLabel`) 우선. `getByRole("alert")`는 Next의 route announcer와 겹치니 텍스트로 좁힌다.

## 코드 컨벤션

- TypeScript strict, 2칸 들여쓰기, 큰따옴표, 세미콜론. 기존 파일의 밀도(한 줄 JSX, 짧은 헬퍼)와 이름 짓는 방식을 따른다.
- 화면 문구와 `aria-label`은 한국어. 아이콘만 있는 버튼에는 반드시 `aria-label`(+`title`)을 단다.
- 주석은 "왜"만 쓴다. 무엇을 하는지 설명하는 주석은 쓰지 않는다.
- 스타일은 `app/globals.css` 한 파일. 색은 `:root` 변수(`--ink`, `--muted`, `--paper`, `--line` …)를 쓴다.
- 새 의존성은 꼭 필요할 때만 추가한다.
- 사용자에게 보여야 하는 실패를 `.catch(() => undefined)`로 삼키지 않는다. 저장 실패 등은 `setMessage(...)`로 알린다(피드에서는 상단 토스트로 뜨고 4초 뒤 사라짐).

## 모바일/iOS 규칙 (실제로 버그가 났던 부분)

- **IndexedDB에 `Blob`을 저장하지 않는다.** WebKit 개인정보 보호 모드에서는 Blob 저장이 실패하고, IDB에서 읽은 Blob은 레코드가 바뀌면 깨질 수 있다. `ArrayBuffer + type`으로 저장한다(`draft-store.ts`).
- 사진 추가/삭제/정렬은 **바뀐 레코드만** 쓴다. 전체를 지우고 다시 쓰지 않는다. 순서는 `profiles` 스토어의 `draft-order`에 id 배열로 따로 저장한다.
- 화면의 이미지는 메모리의 Blob으로 만든 `blob:` URL을 쓰고, 원본 Blob을 `Post.blob`에 들고 있는다. iOS가 백그라운드에서 `blob:` URL을 무효화해도 `onError`에서 새 URL로 복구한다.
- 저장 쓰기는 `persist()` 큐로 직렬화한다(정렬이 추가보다 먼저 저장되는 일 방지).
- `viewportFit: "cover"`이므로 화면 상단/하단에 붙는 요소는 `env(safe-area-inset-top/bottom)` 여백을 넣는다. 빠지면 상태바 아래로 들어가 흐릿하게(블러) 보인다.
- 비동기 확정 버튼(편집기 확인 등)은 처리 중 잠가서 연타로 중복 추가되지 않게 한다.
- 온보딩 완료 여부는 localStorage `mygrid:identity`의 `onboarded`로 판단한다. 아이디가 비어 있어도 피드를 복원해야 한다.

## Git

- 커밋 메시지: 영어, 명령형, 짧은 한 줄 (`Fix ...`, `Add ...`, `Improve ...`, `Simplify ...`, `Prevent ...`).
- 변경 하나당 커밋 하나. 관련 없는 수정을 섞지 않는다.
- 커밋/푸시는 사용자가 요청할 때만 한다.
- `next dev`가 바꾸는 `next-env.d.ts`(`.next/dev/types` 경로)는 커밋하지 않는다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
