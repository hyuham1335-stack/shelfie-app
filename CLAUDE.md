# 프로젝트: Shelfie (셸피) — 책장 사진 기반 책 추천

## 문서

작업 전 아래 문서를 읽고 프로젝트의 기획·기술·설계 의도를 파악할 것. 세부 내용은 이 파일에 중복해서 적지 않고 각 문서에서 관리한다.

| 문서 | 다루는 내용 |
|------|------------|
| `/docs/PRD.md` | Core Input, 성공·가드레일 지표, 유저 스토리와 AC, 기능·데이터 요구사항(MoSCoW), UX·엣지 케이스, GTM·이벤트 로그, 리스크 |
| `/docs/TRD.md` | 기술 스택과 선택 근거, 시스템 요구사항, 데이터 설계·인덱싱, 비기능 요구사항(성능·관측성·보안), 외부 의존성·장애 격리, 테스트 전략, 배포·인프라, 기술 부채 |
| `/docs/API_SPEC.md` | 공통 규약, 엔드포인트 목록, 요청·응답 스키마, 에러 응답 규약, 인증 흐름 |
| `/docs/ARCHITECTURE.md` | 디렉토리 구조, 패턴, 데이터 흐름, 상태 관리 |
| `/docs/ADR.md` | 기술 선택의 배경과 트레이드오프 |
| `/docs/UI_GUIDE.md` | 디자인 원칙, 색상, 컴포넌트, 레이아웃, 타이포그래피 |

`docs/harness/`는 하네스 템플릿 자체의 문서다 (`ROADMAP.md` — 승격 로드맵, `DECISIONS.md` — `ADR-H` 결정 기록). 프로젝트 작업 중에는 **읽기만 하고 고치지 않는다.**

## 아키텍처 규칙

- CRITICAL: 기술 스택은 `/docs/TRD.md`와 `/docs/ADR.md`에서 결정된 범위를 벗어나지 말 것. 새 의존성이 필요하면 먼저 ADR로 논의할 것
- CRITICAL: 디렉토리 구조와 레이어 경계는 `/docs/ARCHITECTURE.md`를 따를 것
- CRITICAL: 아키텍처 구조·흐름을 문서에 표현할 때는 항상 Mermaid로 작성할 것. ASCII 아트 트리나 화살표 나열은 금지한다. 다이어그램 종류 선택 기준은 `/docs/ARCHITECTURE.md`의 작성 규칙 표를 따른다
- CRITICAL: 모든 API 로직은 `app/api/` 라우트 핸들러에서만 처리할 것. API 계약은 `/docs/API_SPEC.md`를 단일 출처로 삼고, 계약 변경 시 해당 문서를 먼저 갱신할 것
- CRITICAL: Claude와 알라딘의 모든 응답은 `lib/schemas.ts`의 zod 스키마 파싱을 통과한 뒤에만 사용할 것. 파싱에 실패한 책은 조용히 버리지 말고 미확인(`UnidentifiedBook`)으로 강등할 것. 알라딘 대조를 통과하지 않은 책을 확인된 책으로 표시하거나 추천 후보에 넣는 것은 이 프로젝트에서 가장 심각한 결함이다 (`/docs/ADR.md` ADR-002)
- CRITICAL: 화면에 표시되는 모든 책 정보는 출처를 구분할 것. 알라딘에서 온 사실(제목·저자·출판사·쪽수·평점)과 Claude가 생성한 해석(`claudeNote`·추천 `reason`)을 같은 시각적 층위로 섞지 말 것. 생성 텍스트는 `/docs/UI_GUIDE.md`의 "Claude 생성 텍스트 블록" 형태로만 렌더한다
- CRITICAL: 확인된 책이 요청 경계를 넘을 때는 서버 서명(`proof`)을 동반할 것. 클라이언트가 보낸 책 목록을 형식만 검사하고 사실로 취급하지 말 것 — 화이트리스트 검증(FR-009)은 모델 출력이 입력과 일치하는지만 보며, 입력 자체가 진짜인지는 묻지 않는다 (`/docs/ADR.md` ADR-006)
- CRITICAL: 외부 호출의 **실패**와 **데이터 없음**을 같은 사유로 뭉개지 말 것. 알라딘 조회가 5xx·타임아웃으로 실패한 책은 `no_match`(검색 결과 없음)가 아니라 `lookup_failed`(지금 확인 못 함)로 강등한다. 시스템 문제를 데이터 문제로 설명하는 것은 "왜 빠졌는지 보여준다"는 원칙을 정면으로 위반한다 (`/docs/ADR.md` ADR-005)
- UI 작업은 `/docs/UI_GUIDE.md`의 규칙과 안티패턴 목록을 따를 것

## 개발 프로세스

- CRITICAL: 새 기능 구현 시 반드시 테스트를 먼저 작성하고, 테스트가 통과하는 구현을 작성할 것 (TDD). 테스트 범위와 커버리지 기준은 `/docs/TRD.md`를 따른다
- 커밋 메시지는 conventional commits 형식을 따를 것 (feat:, fix:, docs:, refactor:)

## 명령어
npm run dev      # 개발 서버
npm run build    # 프로덕션 빌드
npm run lint     # ESLint
npm run test     # 테스트
npm audit --audit-level=high   # 의존성 취약점 게이트 (high 이상이면 배포 차단)
