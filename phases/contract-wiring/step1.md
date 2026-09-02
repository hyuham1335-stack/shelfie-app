# Step 1: analytics-event — 추천 실패를 이벤트로 남긴다

지금 `/api/recommend`는 실패할 때 **경고 한 줄**(`warnBurnedTokens`)만 찍는다. 그래서 세 가지가 집계에서 사라진다: 추천 단계의 에러율, 실패에 태운 토큰(실패해도 청구된다), 실패 사유의 분포. `/docs/PRD.md` 7번 표에 `recommend_failed`가 신설됐다. 이 step 은 **그 이벤트를 로거가 표현할 수 있게** 만든다. 라우트가 실제로 부르는 것은 step 2 다.

## 읽어야 할 파일

- `/docs/PRD.md` — 7번 이벤트 로그 절 **전문**. `recommend_failed` 행과 그 아래 "추천 실패는 `recommend_viewed`를 올리지 않는다" 불릿. 3번 성공·가드레일 지표 표(에러율·세션당 비용)도 함께 본다
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계. `lib/`가 무엇을 import 할 수 있는지
- `src/lib/analytics.ts` — `AnalyticsEvent` 유니온 · `PROPERTY_KEYS` · `project` · `logEvent`
- `src/lib/analytics.test.ts` — 이벤트마다 출력 전체를 대조하는 패턴
- `src/lib/schemas.ts` — `errorCodeSchema` (`error_code`의 타입 출처)
- `src/app/api/analyze/route.ts` — `analyze_failed`를 남기는 자리. **이 이벤트가 템플릿이다**

## 작업

`src/lib/analytics.ts`에 이벤트 하나를 더한다. PRD 7번 표가 정한 속성은 넷이다:

```ts
/** 추천 실패 응답 반환 직전 — 에러율(가드레일) · 세션당 비용(가드레일) */
| {
    event: "recommend_failed";
    session_id: string;
    error_code: z.infer<typeof errorCodeSchema>;
    input_tokens: number;
    output_tokens: number;
  }
```

`PROPERTY_KEYS`에도 같은 키 목록을 넣는다. 타입이 각 이벤트의 실제 키만 허용하므로 표에 없는 이름은 여기 적을 수 없다.

세 가지를 정확히 지켜라:

1. **`input_tokens`·`output_tokens`는 옵셔널이 아니다.** 파일 상단 주석이 이유를 적고 있다 — 일부 호출의 토큰이 빠지면 세션당 비용이 실제보다 낮게 집계되어, 가드레일이 통과할 수 없는 조건에서도 통과한다. **실패한 호출의 토큰도 청구된다**는 것이 이 이벤트를 만드는 이유의 절반이다
2. **`analyze_failed`가 템플릿이다.** 같은 짝(`analyze_completed`/`analyze_failed`)을 흉내 내되, `analyze_failed`에 있는 `failed_photo_count`처럼 추천과 무관한 속성을 옮겨오지 마라. `duration_ms`도 넣지 마라 — PRD 표에 없다
3. **파일 상단 주석의 "이벤트 8종"을 9종으로 고쳐라.** 그 문장이 PRD 7번 표와 1:1 대응을 주장하고 있으므로, 숫자를 남겨 두면 주석이 거짓말이 된다

`recommend_viewed`는 **그대로 둔다.** 실패가 그 이벤트를 올리지 않는다는 것이 요점이지, 성공 경로를 바꾸는 것이 아니다.

### 테스트

`src/lib/analytics.test.ts`가 이벤트마다 출력 전체를 대조하는 패턴을 쓰고 있다. 같은 모양으로 더한다:

- `recommend_failed`가 JSON **한 줄**로 나가고 키가 정확히 5개(`event` 포함)다
- 표에 없는 키(예: `mood` · `request_id` · `books`)를 얹어도 로그에 실리지 않는다 — 화이트리스트 투영 검증
- `error_code`가 `errorCodeSchema`의 값이면 전부 통과한다

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

## 검증 절차

1. 위 AC 커맨드를 순서대로 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 속성 이름·개수가 PRD 7번 표와 **1:1**인가? (표에 없는 속성을 추가하지 않았는가)
   - `lib/`가 외부 호출·로깅 라이브러리를 쓰지 않는가? (ARCHITECTURE 레이어 경계)
   - PII·이미지·판독 원문(`rawText`)이 로그에 닿을 경로가 없는가? (PRD 7번)
3. 결과에 따라 `phases/contract-wiring/index.json`의 step 1 을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에 **최종 속성 목록**을 남겨라. step 2 가 이 이벤트를 부른다.

## 금지사항

- **`src/app/api/recommend/route.ts`를 고치지 마라.** 이유: `warnBurnedTokens`를 이벤트로 바꾸는 것은 step 2 다. 이 step 은 로거가 그 이벤트를 **표현할 수 있게** 만들 뿐이다
- **`recommend_viewed`를 지우거나 옵셔널로 만들지 마라.** 이유: 성공 경로의 정본이고 추천 수락률의 분모다
- **`logEvent`의 실패 처리를 바꾸지 마라.** 이유: 로깅 실패를 호출부로 전파하지 않되 조용히 삼키지도 않는 지금 구조가 TR-012 의 요구다
- **기존 테스트를 깨뜨리지 마라.**
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- `docs/**` · `harness/**` · `scripts/**` 를 고치지 마라. 이유: 메인 소유 경계다
