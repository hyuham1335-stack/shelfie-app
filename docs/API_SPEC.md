# API 명세: Shelfie (셸피)

CRITICAL: 모든 API 로직은 `app/api/` 라우트 핸들러에서만 처리한다. 클라이언트 컴포넌트에서 외부 API를 직접 호출하지 않는다. 라우트 핸들러와 `services/` 래퍼의 관계는 `/docs/ARCHITECTURE.md`의 레이어 의존 관계를 따른다.

---

## 공통 규약

| 항목 | 값 |
|------|------|
| Base URL | `/api` |
| 요청/응답 형식 | `application/json`, UTF-8. 이미지는 base64 문자열로 JSON 본문에 담는다 |
| 인증 헤더 | 없음 (로그인 없는 서비스) |
| 버저닝 | 없음. 클라이언트와 서버가 같은 배포 단위라 버전 스큐가 발생하지 않는다 |
| 타임아웃 (서버 하드 상한) | `/api/analyze` 60s, `/api/recommend` 30s, `/api/mood/questions` 30s, `/api/books/resolve` 10s, `/api/events` 3s |
| 요청 본문 크기 | 전체 **4MB 이하** (플랫폼 상한 4.5MB). `/api/analyze`는 base64 이미지 합계가 여기에 걸린다 |

- 요청 본문은 라우트 핸들러 진입점에서 반드시 `lib/schemas.ts`의 zod 스키마 검증을 거친다. 클라이언트 검증을 신뢰하지 않고 장수·MIME·크기를 서버에서 재확인한다.
- 응답 타입은 `types/`에 정의하고 클라이언트와 공유한다. 스키마와 타입을 이중 정의하지 않고 `z.infer`로 파생한다.
- 모든 요청은 `sessionId`(클라이언트 생성 UUID v4)를 함께 보낸다. 인증이 아니라 이벤트 로그에서 한 세션의 요청을 묶는 용도이며, 서버는 이 값을 신뢰하거나 검증하지 않는다.
- 모든 응답에 `X-Request-Id` 헤더를 붙인다. 성공·실패 응답 모두 붙이며, **에러 응답은 본문에도 `requestId`를 담는다**. 사용자가 화면에서 읽어 신고한 ID로 서버 로그를 바로 찾을 수 있어야 한다 (`/docs/UI_GUIDE.md`의 "에러 배너" 규격).
- 위 타임아웃은 **하드 상한**이고, `/docs/TRD.md` 6.1의 p95는 **목표**다. 값이 다른 것은 모순이 아니다. 클라이언트 `fetch` 타임아웃은 서버 상한보다 길게 잡는다(`/api/analyze` 기준 70s) — 같은 값이면 클라이언트가 먼저 끊어 504와 안내 문구를 받지 못한다.
- `/api/analyze`의 단계별 시간 예산은 `/docs/TRD.md` 7번의 시간 예산 표를 따른다. 예산 초과는 요청 실패가 아니라 해당 항목의 강등으로 처리한다.

---

## 엔드포인트 목록

| 메서드 | 경로 | 설명 | 인증 |
|--------|------|------|------|
| POST | `/api/analyze` | 책장 사진 1~5장에서 책을 추출하고 알라딘 대조 후 확인·미확인으로 분류 | 불필요 |
| POST | `/api/books/resolve` | 사용자가 고친 제목으로 알라딘 재검색, 후보 반환 | 불필요 |
| POST | `/api/mood/questions` | 확인된 책 목록을 근거로 기분 유도 질문 2~3개 생성 | 불필요 |
| POST | `/api/recommend` | 확인된 책 목록과 기분 텍스트로 3권 추천 | 불필요 |
| POST | `/api/events` | 클라이언트에서만 관측 가능한 이벤트를 서버 로그로 남긴다 | 불필요 |

---

## 엔드포인트 상세

엔드포인트마다 아래 블록을 하나씩 추가한다.

### POST /api/analyze

**설명**: 책장 사진에서 책등을 판독해 책 후보를 뽑고, 알라딘과 대조해 확인된 책과 미확인 책으로 나눈다. 확인된 책에는 Claude 한줄평을 배치로 붙인다. (US-001, TR-006)
**인증**: 불필요
**연동 서비스**: `services/anthropic.ts` (추출 · 한줄평), `services/aladin.ts` (대조)

요청 파라미터:

| 위치 | 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|------|
| body | `sessionId` | string | O | 클라이언트 생성 UUID v4 |
| body | `images` | string[] | O | base64 데이터 URI. 1~5개. **장당 2MB 이하이고 전체 합계 4MB 이하** |

요청 본문:
```json
{
  "sessionId": "string — UUID v4",
  "images": ["string — data:image/jpeg;base64,... (1~5개, 장당 2MB · 합계 4MB 이하)"]
}
```

응답 (200):
```json
{
  "sessionId": "string — 요청의 값을 그대로 반향",
  "identified": [
    {
      "isbn13": "string — 13자리. 중복 제거 키",
      "title": "string — 알라딘 원본",
      "author": "string — 알라딘 원본",
      "publisher": "string — 알라딘 원본",
      "coverUrl": "string — 알라딘 표지 절대 URL",
      "pages": "number | null — 정보 없으면 null",
      "aladinRating": "number | null — 0.0~10.0 독자평점, 없으면 null",
      "aladinLink": "string — 알라딘 상품 페이지 URL",
      "claudeNote": "string — Claude 한줄평 0~60자. 생성 실패 시 빈 문자열",
      "photoIndex": "number — 최초 등장 사진 인덱스 (0-based)",
      "proof": "string — 서버 서명. 이 책이 알라딘 대조를 통과했음을 증명한다 (ADR-006). 유효기간 2시간"
    }
  ],
  "unidentified": [
    {
      "rawText": "string — 사진에서 읽힌 원문 그대로",
      "reason": "string — unreadable | no_match | ambiguous | lookup_failed",
      "candidates": [
        {
          "isbn13": "string",
          "title": "string",
          "author": "string",
          "publisher": "string",
          "coverUrl": "string"
        }
      ]
    }
  ],
  "overflowCount": "number — 50권 상한으로 잘려나간 권수 (FR-005)",
  "unidentifiedOverflowCount": "number — 미확인 100건 상한으로 잘려나간 개수",
  "failedPhotoCount": "number — 추출에 실패한 사진 수. 0이면 전부 성공",
  "failedPhotoIndexes": "number[] — 실패한 사진의 0-based 인덱스. 그 사진만 골라 재시도하기 위한 값"
}
```

- `identified`는 최대 50건이다. 초과분을 절단하는 순서는 **결정적**이어야 한다: `aladinRating` 내림차순 → `null`은 최하위 → 동점은 `photoIndex` 오름차순 → `isbn13` 오름차순. 잘려나간 권수는 `overflowCount`에 남긴다. (정렬이 비결정적이면 같은 입력에 다른 결과가 나와 테스트할 수 없다.)
- `unidentified`는 최대 100건이다. 초과분은 버리고 개수만 `unidentifiedOverflowCount`에 남긴다. 상한이 없으면 모델이 후보를 대량으로 쏟아냈을 때 응답과 화면이 함께 무너진다.
- `candidates`는 `reason`이 `ambiguous`일 때만 채운다(최대 5건). 그 외에는 빈 배열이다. 클라이언트는 이 후보를 재검색 없이 바로 고를 수 있게 보여준다.
- **`reason` 4종의 의미는 서로 겹치지 않는다.** `unreadable`(판독 실패) / `no_match`(알라딘에 정말 없음) / `ambiguous`(후보 복수) / `lookup_failed`(알라딘을 조회하지 못함 — 5xx·타임아웃·대조 예산 소진). 조회 실패를 `no_match`로 내보내면 사용자에게 "원서·절판일 수 있어요"라는 **사실이 아닌 설명**을 하게 된다 (ADR-005).
- 일부 사진이 실패해도 성공한 사진의 결과를 담아 200으로 응답한다. 전 사진이 실패했을 때만 502다.
- **후보는 추출됐으나 확인된 책이 0건**인 경우(알라딘 장애, 전량 미확인)는 `EMPTY_SHELF`가 아니다. 200으로 `identified: []`와 미확인 목록을 반환하고, 클라이언트는 `unidentifiedOnly` 상태로 분기한다. `EMPTY_SHELF`는 **추출 후보 자체가 0건**일 때만 쓴다.

실패 응답: 400(스키마 검증 실패 — 장수 초과, 지원하지 않는 MIME, 크기 초과), 404(추출된 후보가 0건 — `EMPTY_SHELF`), 502(모든 사진의 추출 실패 또는 Anthropic 장애), 504(60s 타임아웃)

### POST /api/books/resolve

**설명**: 미확인으로 분류된 책의 제목을 사용자가 고쳐 보냈을 때 알라딘에서 다시 찾아 후보를 돌려준다. (US-002, TR-008)
**인증**: 불필요
**연동 서비스**: `services/aladin.ts`

요청 파라미터:

| 위치 | 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|------|
| body | `sessionId` | string | O | 클라이언트 생성 UUID v4 |
| body | `query` | string | O | 사용자가 고친 제목. 1~200자 |
| body | `author` | string | X | 저자를 아는 경우 함께 보내 정확도를 높인다 |

요청 본문:
```json
{
  "sessionId": "string — UUID v4",
  "query": "string — 수정된 제목 (1~200자)",
  "author": "string | null — 선택"
}
```

응답 (200):
```json
{
  "candidates": [
    {
      "isbn13": "string",
      "title": "string",
      "author": "string",
      "publisher": "string",
      "coverUrl": "string",
      "pages": "number | null",
      "aladinRating": "number | null",
      "aladinLink": "string",
      "proof": "string — analyze와 같은 형식의 서버 서명 (ADR-006)"
    }
  ]
}
```

- 후보에도 `proof`를 붙인다. 사용자가 고른 책이 추천 요청에 합류할 때 **확인된 책과 동등한 증명**을 갖고 있어야 하기 때문이다. 이 경로에 서명이 없으면 US-002가 곧 검증 우회 통로가 된다.
- 최대 5건을 알라딘 검색 순위 그대로 반환한다. 서버가 임의로 1건을 고르지 않고 선택은 사용자에게 맡긴다.
- 이 응답의 책에는 `claudeNote`가 없다. 사용자가 후보를 확정한 뒤 클라이언트가 목록에 합류시키며, 한줄평은 비워 둔다.

실패 응답: 400(빈 문자열 또는 200자 초과), 404(검색 결과 0건 — `NOT_FOUND_IN_ALADIN`), 502(알라딘 장애), 504(10s 타임아웃)

### POST /api/mood/questions

**설명**: 기분 입력을 비워 둔 사용자를 위해, 확인된 책 목록의 구성을 근거로 좁혀 가는 질문 2~3개를 생성한다. (US-004, TR-009)
**인증**: 불필요
**연동 서비스**: `services/anthropic.ts`

요청 파라미터:

| 위치 | 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|------|
| body | `sessionId` | string | O | 클라이언트 생성 UUID v4 |
| body | `books` | object[] | O | 확인된 책 목록. 각 항목은 `isbn13`·`title`·`author`·`proof`만 보낸다. 1~50개 |

요청 본문:
```json
{
  "sessionId": "string — UUID v4",
  "books": [
    { "isbn13": "string", "title": "string", "author": "string", "proof": "string" }
  ]
}
```

응답 (200):
```json
{
  "questions": [
    {
      "id": "string — 클라이언트가 답변을 매핑하는 키",
      "question": "string — 10~60자",
      "options": ["string — 선택지 3~4개"]
    }
  ]
}
```

- `questions`는 2~3개다. 생성 실패든 Anthropic 장애든 **200과 빈 배열**을 반환한다. 클라이언트는 빈 배열을 받으면 자유 입력 화면으로 폴백하고 세션을 끊지 않는다. 클라이언트 동작이 어차피 같으므로 502로 나누지 않는다 — 상태 코드를 나누면 두 경로를 모두 구현해야 하고 둘 중 하나는 반드시 덜 검증된다.

실패 응답: 400(책 목록이 비었거나 50개 초과), 504(30s 타임아웃). **502는 쓰지 않는다** — 모델 장애도 200 + 빈 배열로 흡수한다.

### POST /api/recommend

**설명**: 확인된 책 목록 안에서만 골라 3권을 추천하고 각각의 이유를 붙인다. 모델이 목록 밖 책을 반환하면 1회 재요청하고, 그래도 실패하면 502로 끊는다. (US-003, FR-006, FR-009, TR-010)
**인증**: 불필요
**연동 서비스**: `services/anthropic.ts`

요청 파라미터:

| 위치 | 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|------|
| body | `sessionId` | string | O | 클라이언트 생성 UUID v4 |
| body | `books` | object[] | O | 확인된 책 목록. `isbn13`·`title`·`author`·`pages`·`claudeNote`·`proof`. 1~50개 |
| body | `mood` | string | O | 기분·상황 텍스트. 2~500자. 문답 답변을 합성한 문자열도 여기에 담는다 |
| body | `inputMode` | string | O | `free_text` 또는 `guided`. 이벤트 로그 속성으로만 쓴다 |
| body | `retryIndex` | number | O | "다시 추천받기" 횟수. 0~4 (FR-010의 세션당 5회 상한). `mood_submitted.retry_index`가 되는 값 |
| body | `irrelevantStreak` | number | O | 직전까지 **연속으로** 받은 `IRRELEVANT_MOOD` 횟수. 0~2. 추천에 성공하거나 다른 오류가 나면 0으로 되돌린다 |

요청 본문:
```json
{
  "sessionId": "string — UUID v4",
  "books": [
    {
      "isbn13": "string",
      "title": "string",
      "author": "string",
      "pages": "number | null",
      "claudeNote": "string",
      "proof": "string — analyze 또는 resolve가 발급한 서명"
    }
  ],
  "mood": "string — 2~500자",
  "inputMode": "string — free_text | guided",
  "retryIndex": "number — 0~4",
  "irrelevantStreak": "number — 0~2"
}
```

응답 (200):
```json
{
  "recommendations": [
    {
      "bookId": "string — 요청 books의 isbn13 중 하나임이 서버에서 검증됨",
      "reason": "string — 추천 이유 20~200자",
      "position": "number — 1 | 2 | 3"
    }
  ],
  "shortfall": "boolean — 확인된 책이 3권 미만이라 추천 수가 부족한 경우 true"
}
```

- **먼저 각 책의 `proof`를 검증한다.** 서명이 없거나 위조됐거나 만료된 책은 그 책만 버리고 나머지로 진행한다(요청 전체를 실패시키지 않는다). 남은 책이 0권이면 400 `UNVERIFIED_BOOKS`다. 이 검사가 없으면 클라이언트가 보낸 목록이 진짜인지 확인할 방법이 없고, `bookId` 화이트리스트는 **모델 출력이 입력과 일치하는지**만 볼 뿐 그 입력이 사실인지는 묻지 않는다 (ADR-006).
- `recommendations`의 모든 `bookId`는 검증을 통과한 `books`의 `isbn13` 집합에 속한다. 이 검증을 통과하지 못한 응답은 사용자에게 도달하지 않는다.
- **재요청은 같은 프롬프트를 반복하지 않는다.** 위반한 `bookId`를 모델에 명시하고 허용 목록을 다시 제시한 뒤 1회만 재요청한다. 동일 입력을 그대로 다시 보내면 같은 실패를 반복할 가능성이 높다.
- 확인된 책이 3권 미만이면 있는 권수만큼만 반환하고 `shortfall`을 `true`로 둔다.
- **`IRRELEVANT_MOOD` 판정 주체는 모델이다.** 서버가 키워드로 판정하지 않는다. 추천 프롬프트의 구조화 출력에 `relevant: boolean`을 함께 받고, `false`면 추천 대신 422를 반환한다. 다만 **같은 세션에서 2회 연속 `false`가 나오면 판정을 무시하고 추천을 진행한다** — 오탐으로 사용자를 입력 화면에 가두는 것이 억지 추천 한 번보다 나쁘다. **횟수는 클라이언트가 세어 `irrelevantStreak`로 싣고, 무시 판정은 서버가 한다** — 무상태라 서버가 셀 수는 없지만, 판정을 클라이언트에 맡기면 같은 규칙이 화면마다 다시 구현된다. `irrelevantStreak >= 2`인 요청은 모델이 `relevant: false`를 내도 422를 반환하지 않고 추천을 진행한다 (US-003).
- `mood`는 사용자가 쓴 자유 텍스트이므로 **데이터로만** 다룬다. 시스템 프롬프트에 이어 붙이지 않고 사용자 메시지 안의 구분된 블록에 넣는다 (`/docs/TRD.md` 6.5 프롬프트 인젝션). 출력은 어차피 `isbn13` 화이트리스트로 걸러진다.
- "다시 추천받기"는 세션당 5회로 제한한다(FR-010). 클라이언트가 카운트하고 서버는 강제하지 않는다 — 무상태라 세션별 카운터를 서버에 둘 수 없기 때문이며, 이 한도는 남용 방어가 아니라 실수로 인한 비용 누수를 막는 장치다.
- **`retryIndex`·`irrelevantStreak`는 서명하지 않는다.** `sessionId`와 같은 취급이다(위 공통 규약). `proof`(ADR-006)가 필요한 이유는 **책이 사실인 척할 수 있기 때문**인데, 이 두 값은 위조해도 얻는 것이 **원래 허용된 동작 하나**뿐이다 — `irrelevantStreak`를 2로 보내면 세 번째에 어차피 허용되는 억지 추천 한 번을 앞당길 뿐이고, `retryIndex`는 로그 속성이다. 검증하는 대신 **스키마가 상한을 강제한다**(`retryIndex` 0~4 · `irrelevantStreak` 0~2). 상한 밖은 400이다.
- **두 필드는 옵셔널이 아니라 필수다.** 기본값 0을 두면 **"보내지 않았다"와 "0회다"가 구분되지 않는다.** 그것이 `mood_submitted.retry_index`가 언제나 0으로 기록되던 원인이고, 클라이언트가 배선을 잊어도 지표가 조용히 거짓말한다. 버저닝이 없고 클라이언트와 서버가 같은 배포 단위라 버전 스큐가 없으므로(위 공통 규약) 필수로 두는 비용도 없다.

실패 응답: 400(스키마 검증 실패, 책 목록이 비었거나 50개 초과, `mood`가 2자 미만, `retryIndex`·`irrelevantStreak`가 범위 밖, 서명 통과 0권 — `UNVERIFIED_BOOKS`), 422(책 고르기와 무관한 입력 — `IRRELEVANT_MOOD`), 502(재요청 후에도 목록 밖 책을 반환 — `RECOMMENDATION_VALIDATION_FAILED`, 또는 Anthropic 장애), 504(30s 타임아웃)

### POST /api/events

**설명**: 클라이언트에서만 관측할 수 있는 이벤트를 서버 로그로 남긴다. North Star 지표인 추천 수락률의 분자(`recommend_accepted`)는 순수한 클릭 이벤트라 서버가 알 수 없고, 이 엔드포인트가 없으면 **가설 검증 자체가 불가능하다**. (PRD 7번, TR-014)
**인증**: 불필요
**연동 서비스**: 없음. `lib/analytics.ts`로 표준 출력에 한 줄 쓰고 끝난다. 저장하지 않는다 (ADR-003).

요청 파라미터:

| 위치 | 이름 | 타입 | 필수 | 설명 |
|------|------|------|------|------|
| body | `sessionId` | string | O | 클라이언트 생성 UUID v4 |
| body | `event` | string | O | 아래 화이트리스트 중 하나 |
| body | `properties` | object | X | 해당 이벤트에 정의된 속성만. 그 외 키는 무시하고 버린다 |

요청 본문:
```json
{
  "sessionId": "string — UUID v4",
  "event": "string — recommend_viewed | recommend_accepted | book_resolved",
  "properties": { "position": 1 }
}
```

응답 (202):
```json
{ "accepted": true }
```

- 허용 이벤트는 **`recommend_viewed`·`recommend_accepted`·`book_resolved` 3종뿐**이다. 나머지 이벤트는 서버가 직접 관측할 수 있으므로 이 경로로 받지 않는다. 목록 밖 이름은 400이다.
- 속성은 화이트리스트로 걸러 기록한다. 클라이언트가 보낸 임의의 키를 그대로 로그에 쓰면 PII가 흘러들어올 수 있다.
- 본문은 8KB를 넘을 수 없다. 로그 한 줄로 남길 값에 그 이상이 필요할 이유가 없다.
- **202로 응답하고 결과를 기다리지 않는다.** 로깅 실패가 사용자 화면에 영향을 주면 안 된다 (TR-012).
- `sessionId`는 여전히 신뢰하지 않는다. 위조하면 지표가 오염되지만 인증 없는 서비스에서 감수하는 비용이며, 지표는 절대값이 아니라 추세로 읽는다.

실패 응답: 400(허용 목록 밖 이벤트명, 스키마 위반, 본문 8KB 초과)

---

## 에러 응답 규약

모든 에러는 아래 형태로 통일한다.

```json
{
  "error": "{사용자에게 보여줄 메시지}",
  "code": "{내부 에러 코드}",
  "requestId": "{X-Request-Id 헤더와 같은 값}"
}
```

| 상태 코드 | 상황 | 대응 |
|-----------|------|------|
| 400 | 잘못된 입력 / zod 스키마 검증 실패 (장수 초과, 지원하지 않는 MIME, 크기 초과, 길이 위반) | 어떤 조건을 위반했는지 사용자 언어로 알린다. 필드 경로나 zod 원본 메시지는 노출하지 않는다 |
| 404 | 리소스 없음 — 추출된 책이 0건(`EMPTY_SHELF`), 알라딘 검색 결과 0건(`NOT_FOUND_IN_ALADIN`) | 빈 목록을 렌더하지 않고 재촬영·재검색 안내로 분기한다 |
| 422 | 요청 형식은 맞으나 처리할 수 없는 입력 — 책 고르기와 무관한 기분 텍스트(`IRRELEVANT_MOOD`) | 예시 문장과 함께 다시 입력받는다 |
| 413 | 요청 본문이 상한(4MB) 초과 | 클라이언트가 전송 전에 합계를 계산해 막는 것이 원칙이다. 여기까지 왔다면 사진 장수를 줄이거나 품질을 낮추도록 안내한다 |
| 429 | 레이트 리밋 초과 (Scale 단계에서 도입) | `Retry-After` 헤더를 함께 반환. 클라이언트는 지수 백오프 |
| 500 | **우리 쪽 결함** — 서버가 만든 응답이 우리 스키마를 통과하지 못했거나, 예상하지 못한 예외 | 재시도 버튼을 제공한다. 사용자에게는 502와 같은 문구를 보이되 **로그와 코드에서는 502와 구분한다** |
| 503 | `SERVICE_ENABLED=false`로 긴급 차단 중 | 점검 안내를 보여주고 재시도 버튼을 숨긴다. 외부 API를 호출하지 않으므로 비용이 발생하지 않는다 |
| 502 | 외부 API 오류 — Anthropic·알라딘 장애, 추천 응답 검증 2회 실패 | 재시도 버튼을 제공하고 사용자 입력 상태(선택한 사진·기분 텍스트)를 유지한다 |
| 504 | 타임아웃 | 502와 동일하게 처리하되, 사진 장수를 줄여 다시 시도하도록 안내한다 |

**500과 502를 뭉개지 않는다.** 우리 응답이 우리 계약을 어긴 것을 502로 내보내면 상대 서비스의 장애로 기록된다. 알라딘 장애를 `no_match`로 적지 않는 것(ADR-005)과 같은 규율이며, 방향만 반대다 — 이쪽은 **우리 결함을 남의 것으로 돌리는** 오귀속이다. 사용자에게 보이는 문구가 같은 것과, 로그에 남는 원인이 같은 것은 다른 문제다.

에러 코드 목록:

| code | 상태 | 의미 |
|------|------|------|
| `INVALID_REQUEST` | 400 | 스키마 검증 실패 전반 |
| `TOO_MANY_PHOTOS` | 400 | 사진 5장 초과 |
| `UNSUPPORTED_IMAGE_TYPE` | 400 | jpeg·png·webp가 아님 |
| `IMAGE_TOO_LARGE` | 400 | 리사이즈 후에도 장당 2MB 초과 |
| `PAYLOAD_TOO_LARGE` | 413 | 요청 본문 합계가 4MB 초과 |
| `EMPTY_SHELF` | 404 | 사진에서 책 후보가 0건 |
| `NOT_FOUND_IN_ALADIN` | 404 | 알라딘 검색 결과 0건 |
| `UNVERIFIED_BOOKS` | 400 | 서명을 통과한 책이 0권 — 목록이 위조됐거나 서명이 만료됨 (ADR-006) |
| `IRRELEVANT_MOOD` | 422 | 책 선택과 무관한 기분 입력 |
| `RATE_LIMITED` | 429 | 레이트 리밋 초과 (Scale) |
| `INTERNAL_ERROR` | 500 | **우리 쪽 결함.** 서버 응답이 자신의 스키마 검증을 통과하지 못했거나, 처리 중 예상하지 못한 예외가 났다 |
| `UPSTREAM_UNAVAILABLE` | 502 | Anthropic 또는 알라딘 장애 |
| `RECOMMENDATION_VALIDATION_FAILED` | 502 | 추천 응답이 입력 목록 밖 책을 반환 (재요청 후에도) |
| `TIMEOUT` | 504 | 처리 시간 초과 |
| `SERVICE_DISABLED` | 503 | `SERVICE_ENABLED=false` — 긴급 차단 중 |

- `INTERNAL_ERROR`로 응답할 때는 원인을 구분할 수 있는 로그를 함께 남긴다. 클라이언트에게 코드를 더 쪼개지 않는 이유는 **클라이언트 동작이 같기 때문**이고(재시도 버튼 하나), 우리가 원인을 알아야 하는 자리는 응답이 아니라 로그이기 때문이다.

- 외부 API 키, 스택 트레이스 등 내부 정보를 응답에 포함하지 않는다.
- 모델이 생성한 원문을 에러 메시지로 그대로 내보내지 않는다. 정해진 문구만 반환한다.

---

## 인증·인가 흐름

**이 서비스에는 인증이 없다.** 로그인·계정·세션이 존재하지 않으므로 인증 흐름 다이어그램을 작성하지 않는다 (ADR-003). 계정을 도입하게 되면 인증도 Supabase Auth로 함께 가며, 그때 이 절에 흐름 다이어그램을 추가한다 (ADR-007) — 그전까지 개별 엔드포인트에 임시 토큰이나 자체 세션 쿠키를 붙이지 않는다.

다만 인증이 없다고 클라이언트를 신뢰하지는 않는다. 라우트 핸들러는 다음을 항상 서버에서 재검증한다.

| 검증 | 무엇을 보장하는가 | 무엇을 보장하지 **못**하는가 |
|------|------------------|---------------------------|
| 이미지 장수·MIME·크기 | 입력이 처리 가능한 형태임 | — |
| `books` 개수 상한(50)과 `isbn13` 형식 | 13자리 숫자이고 개수가 적정함 | **그 책이 실재하는지** |
| 각 책의 `proof` 서명 (ADR-006) | 그 `isbn13`이 알라딘 대조를 통과했고, 우리 서버가 2시간 내에 발급했음 | 그 책이 사용자의 책장에 실제로 꽂혀 있었는지 |
| 추천 응답의 `bookId` 화이트리스트 (FR-009) | 모델이 입력 목록 밖의 책을 지어내지 않았음 | **입력 목록 자체가 진짜인지** |

**두 번째와 네 번째 줄의 "보장하지 못하는 것"이 서로를 메우지 못한다는 점이 핵심이다.** 형식 검사는 값이 그럴듯한지만 보고, 화이트리스트 검사는 출력이 입력과 일치하는지만 본다. 둘 다 통과해도 입력이 처음부터 지어낸 것이면 가짜 책이 추천까지 도달한다. 무상태 설계에서 확인 판정은 응답과 함께 클라이언트로 나갔다가 다시 들어오는데, 서버는 그것이 자기가 내준 값인지 알 수 없기 때문이다. `proof` 서명이 그 간극을 메운다.

`sessionId`는 클라이언트가 만든 임의의 UUID이며 이벤트 로그를 묶는 용도로만 쓴다. 어떤 권한도 부여하지 않는다. 다만 **형식(UUID v4)은 검증한다** — 값을 신뢰하지 않는 것과 아무 문자열이나 로그에 넣는 것은 다르다. 형식에 맞지 않으면 `invalid`로 치환해 기록하고 요청은 정상 처리한다. 지표를 로그에서만 뽑는 구조라 로그가 오염되면 측정이 무너진다.
