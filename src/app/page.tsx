"use client";

/**
 * 세션 셸 — 네 런이 만든 조각을 한 화면에서 잇는다 (TR-011).
 *
 * ## 여기서 하지 않는 일
 * 이 파일은 화면을 새로 만들지 않는다. `components/`의 화면 5종을 상태에 따라 고르고,
 * 사용자의 행동을 `lib/api-client`의 호출과 `lib/session`의 액션으로 옮길 뿐이다.
 * 상태를 직접 계산하지 않는다 — 전이는 전부 `dispatch`로만 일어난다.
 *
 * ## 저장소가 없다 (ADR-003)
 * 브라우저 저장소(로컬·세션 스토리지)와 쿠키를 쓰지 않는다. 새로고침하면 세션이 사라지며
 * 그것은 결함이 아니라 의도된 결과다. 다만 **의도된 소실과 사고로 인한 소실은 다르므로**,
 * 잃을 것이 생긴 뒤에는 `beforeunload`로 이탈을 한 번 되묻는다 (ARCHITECTURE 상태 관리).
 *
 * ## `proof`를 해석하지 않는다 (ADR-006)
 * 서명 문자열을 파싱하거나 만료를 예측하지 않는다. 만료는 서버가 돌려주는
 * `UNVERIFIED_BOOKS`로만 안다 — 클라이언트가 서명을 읽기 시작하면 서명이 지키려던
 * 신뢰 경계가 그 자리에서 무너진다.
 *
 * ## `ambiguous` 후보 승격은 반드시 `isbn13`으로 대조한다
 * 미확인 책에 딸린 후보(`AladinCandidate`)에는 `proof`가 없다. 그대로 목록에 넣으면
 * 추천·문답 요청에서 그 책만 조용히 폐기된다. 그래서 `/api/books/resolve`로 다시 찾아
 * **같은 `isbn13`을 가진 응답 항목**만 합류시킨다. 응답 첫 번째 후보로 대신하지 않는다 —
 * 사용자가 고르지 않은 책을 고른 것처럼 만드는 것은 없는 책을 보여주는 것과 같은 종류의
 * 결함이다 (ADR-002).
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { BookCover } from "@/components/booklist/BookCover";
import { BookList } from "@/components/booklist/BookList";
import { ErrorBanner } from "@/components/common/ErrorBanner";
import { Notice } from "@/components/common/Notice";
import { Skeleton } from "@/components/common/Skeleton";
import { GuidedQuestions } from "@/components/mood/GuidedQuestions";
import { MoodInput, nextIrrelevantCount } from "@/components/mood/MoodInput";
import { RecommendationList } from "@/components/recommend/RecommendationList";
import { UploadScreen } from "@/components/upload/UploadScreen";
import {
  analyzePhotos,
  fetchMoodQuestions,
  requestRecommendations,
  resolveBook,
  sendClientEvent,
} from "@/lib/api-client";
import {
  ANALYZE_RETRY_DELAYS_MS,
  MAX_ANALYZE_RETRIES,
  MAX_IRRELEVANT_STREAK,
  MAX_RETRY_INDEX,
} from "@/lib/env";
import {
  canRecommendAgain,
  createSessionState,
  sessionReducer,
  toBookReferences,
  toRecommendBooks,
} from "@/lib/session";
import type { InputMode, SessionState } from "@/lib/session";
import type { ErrorCode } from "@/types/api";
import type { AladinCandidate, ResolvedCandidate, UnidentifiedBook } from "@/types/book";

/** `resolveRequestSchema.query`의 상한. 넘겨 보내면 400으로 돌아온다 */
const MAX_RESOLVE_QUERY_LENGTH = 200;

/** 미확인 책을 고쳐 찾는 패널의 진행 상태 */
type ResolveStage = "input" | "searching" | "results" | "mismatch" | "notFound" | "failed";

interface ResolvePanel {
  /** 어느 미확인 책을 고치는 중인가. 승격은 이 책의 `rawText`를 목록에서 지운다 */
  target: UnidentifiedBook;
  query: string;
  stage: ResolveStage;
  /** `/api/books/resolve`가 돌려준 후보. **`proof`를 갖고 있다** */
  candidates: ResolvedCandidate[];
  /** 재검색 시도 횟수. `book_resolved` 이벤트의 속성이다 */
  attempt: number;
  errorCode: ErrorCode | null;
}

export default function Home() {
  // sessionId는 마운트 시 한 번만 만든다. 리듀서가 만들면 같은 입력에 같은 출력이
  // 아니게 되어 전이 규칙을 값으로 검사할 수 없다 (lib/session의 전제).
  const [state, dispatch] = useReducer(sessionReducer, undefined, () =>
    createSessionState(crypto.randomUUID()),
  );

  /**
   * 리사이즈까지 마친 사진. **메모리에만 둔다** — 저장소에 남기는 것은 무상태 전제를
   * 문서 없이 우회하는 것이다(ADR-003). 에러가 나도 이 값이 남아 있어 재시도가
   * 재업로드를 요구하지 않는다 (ARCHITECTURE 상태 관리). ref가 아니라 state인 것은
   * 재시도 버튼을 그릴지가 이 값에 달려 있기 때문이다 — 렌더가 읽는 값은 state에 둔다.
   */
  const [photos, setPhotos] = useState<string[]>([]);
  const [analyzeAttempts, setAnalyzeAttempts] = useState(0);
  /** 무관 판정의 **연속** 횟수. 서버는 무상태라 셀 수 없어 화면이 센다 (API_SPEC /api/recommend) */
  const [irrelevantCount, setIrrelevantCount] = useState(0);
  const [panel, setPanel] = useState<ResolvePanel | null>(null);
  /**
   * 재시도 간격을 기다리는 동안 **남은 초** (FR-010). `null`이면 대기 중이 아니다.
   *
   * ref가 아니라 state인 것은 이 값이 화면에 그려지기 때문이다 — 버튼이 눌리는데
   * 아무 일도 일어나지 않으면 사용자는 간격이 아니라 고장으로 읽는다.
   * **저장소에 남기지 않는다** — 새로고침하면 세션이 통째로 사라지므로 대기만
   * 살아남을 이유가 없다 (ADR-003).
   */
  const [retryWaitSec, setRetryWaitSec] = useState<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);

  // 추천 화면은 서지 사실만 필요하므로 출처 구분 없이 책만 편다. 확인된 책 목록
  // 자체는 `BookList`가 `ShelfBook`으로 통째로 받아 한 목록으로 그린다.
  const books = state.books.map((entry) => entry.book);
  const canRetryAnalyze = photos.length > 0 && analyzeAttempts < MAX_ANALYZE_RETRIES;
  const isWaitingRetry = retryWaitSec !== null;

  // 언마운트에서 타이머를 정리한다. 남겨 두면 사라진 화면이 분석을 부른다.
  useEffect(
    () => () => {
      if (retryTimerRef.current !== null) window.clearInterval(retryTimerRef.current);
    },
    [],
  );

  // 잃을 것이 생긴 뒤에만 되묻는다. 아무것도 없는 화면에서 확인창을 띄우면
  // 경고가 소음이 되고, 정작 결과를 들고 있을 때의 경고까지 무시하게 된다.
  const hasResults = state.books.length > 0 || state.unidentified.length > 0;
  useEffect(() => {
    if (!hasResults) return;

    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasResults]);

  /* ---------------------------------------------------------------- *
   * 분석 (US-001)
   * ---------------------------------------------------------------- */

  async function runAnalyze(images: string[]) {
    const result = await analyzePhotos(state.sessionId, images);
    if (result.ok) {
      dispatch({ type: "ANALYZE_SUCCEEDED", result: result.data });
      return;
    }
    dispatch({ type: "ANALYZE_FAILED", code: result.code, requestId: result.requestId });
  }

  /** `photoCount`는 `/api/analyze` 응답에 없다 — 부분 실패 배너의 분모라 여기서 넘어온다 */
  function handleAnalyze(dataUris: string[], photoCount: number) {
    setPhotos(dataUris);
    setAnalyzeAttempts(0);
    dispatch({ type: "ANALYZE_STARTED", photoCount });
    void runAnalyze(dataUris);
  }

  /** 대기 중인 재시도를 취소한다. 취소하면 예약된 분석 호출도 함께 사라진다 */
  function cancelRetryTimer() {
    if (retryTimerRef.current !== null) {
      window.clearInterval(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setRetryWaitSec(null);
  }

  /** 실제로 분석을 다시 태운다. 재시도 회차를 올리는 자리도 여기 하나다 */
  function startRetry(images: string[]) {
    // 다음 응답의 photoIndex는 이번에 보낸 배열을 기준으로 매겨진다. 보낸 것을
    // 그대로 들고 있어야 그 인덱스로 다시 사진을 찾을 수 있다.
    setPhotos(images);
    setAnalyzeAttempts((count) => count + 1);
    setPanel(null);
    dispatch({ type: "ANALYZE_RETRIED", photoCount: images.length });
    void runAnalyze(images);
  }

  /**
   * 실패한 사진만 골라 다시 보낸다. 인덱스가 비어 있으면(전체 실패·조회 실패 재시도)
   * 갖고 있는 사진 전부를 보낸다.
   *
   * **간격은 여기서 한 번만 건다** (FR-010). 에러 화면의 "다시 시도"와 부분 실패
   * 배너의 "이 사진만 다시 시도"가 둘 다 이 함수로 합류하고, 비용이 드는 쪽은
   * 같으므로 간격도 같다. 두 군데에 각각 넣으면 한쪽만 고쳐지는 날이 온다.
   */
  function handleRetryPhotos(photoIndexes: number[]) {
    // 대기 중 재진입을 상태로도 막는다. 버튼 비활성화만으로는 두 경로 중 하나가
    // 빠지는 날에 타이머가 겹친다.
    if (!canRetryAnalyze || isWaitingRetry) return;

    const picked = photoIndexes
      .map((index) => photos[index])
      .filter((uri): uri is string => uri !== undefined);
    const images = picked.length > 0 ? picked : photos;
    if (images.length === 0) return;

    // 이번이 몇 번째 재시도인가(0-based). 첫 재시도는 간격 0초라 즉시 나간다 —
    // 0초 대기에 "0초 남았어요"를 띄우지 않는다.
    const delayMs = ANALYZE_RETRY_DELAYS_MS[analyzeAttempts] ?? 0;
    if (delayMs <= 0) {
      startRetry(images);
      return;
    }

    // 1초마다 남은 초를 깎는다. `remaining`은 클로저 지역 변수다 — 상태 갱신
    // 함수 안에서 부수효과(분석 호출)를 내지 않으려는 것이다.
    let remaining = Math.ceil(delayMs / 1000);
    setRetryWaitSec(remaining);
    retryTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setRetryWaitSec(remaining);
        return;
      }
      cancelRetryTimer();
      startRetry(images);
    }, 1000);
  }

  /* ---------------------------------------------------------------- *
   * 미확인 책 재검색과 승격 (US-002)
   * ---------------------------------------------------------------- */

  function openResolve(book: UnidentifiedBook) {
    setPanel({
      target: book,
      query: book.rawText.slice(0, MAX_RESOLVE_QUERY_LENGTH),
      stage: "input",
      candidates: [],
      attempt: 0,
      errorCode: null,
    });
  }

  async function runResolve(target: UnidentifiedBook, query: string, attempt: number) {
    const trimmed = query.trim().slice(0, MAX_RESOLVE_QUERY_LENGTH);
    if (trimmed.length === 0) return;

    setPanel({
      target,
      query: trimmed,
      stage: "searching",
      candidates: [],
      attempt,
      errorCode: null,
    });

    const result = await resolveBook(state.sessionId, trimmed);
    if (!result.ok) {
      // 검색 결과 0건(데이터 문제)과 조회 실패(시스템 문제)는 다른 문장으로 말한다 (ADR-005).
      setPanel({
        target,
        query: trimmed,
        stage: result.code === "NOT_FOUND_IN_ALADIN" ? "notFound" : "failed",
        candidates: [],
        attempt,
        errorCode: result.code,
      });
      return;
    }

    setPanel({
      target,
      query: trimmed,
      stage: result.data.candidates.length === 0 ? "notFound" : "results",
      candidates: result.data.candidates,
      attempt,
      errorCode: null,
    });
  }

  /**
   * `lookup_failed` 한 권의 재조회 (ADR-005).
   *
   * 알라딘 조회가 5xx·타임아웃으로 **실패**했을 뿐이므로 고칠 제목이 없다. 사용자에게
   * 입력을 요구하지 않고 읽힌 원문 그대로 같은 질의를 다시 보낸다. **사진 재분석을
   * 부르지 않는다** — 알라딘 한 건의 실패에 모델 비용 전체를 다시 낼 이유가 없다.
   */
  function handleRetryLookup(book: UnidentifiedBook) {
    void runResolve(book, book.rawText, 1);
  }

  /**
   * 후보를 목록에 합류시킨다. 여기 들어오는 것은 **`/api/books/resolve`가 발급한
   * `proof`를 가진 후보뿐**이다 (ADR-006).
   */
  function promote(target: UnidentifiedBook, book: ResolvedCandidate, attempt: number) {
    dispatch({ type: "BOOK_RESOLVED", rawText: target.rawText, book });
    void sendClientEvent({
      sessionId: state.sessionId,
      event: "book_resolved",
      properties: { resolve_attempt: attempt, matched: true },
    });
    setPanel(null);
  }

  /**
   * `ambiguous` 후보를 바로 고른 경로 (US-002 AC).
   *
   * 화면에 있던 후보에는 `proof`가 없으므로 재검색으로 같은 책을 다시 받아 온다.
   * **`isbn13`이 일치하는 항목이 없으면 승격하지 않는다** — 응답 순위 1번으로
   * 대신하면 사용자가 고르지 않은 책이 확인된 책으로 둔갑한다.
   */
  async function handleSelectCandidate(target: UnidentifiedBook, candidate: AladinCandidate) {
    const query = `${candidate.title} ${candidate.author}`
      .trim()
      .slice(0, MAX_RESOLVE_QUERY_LENGTH);

    setPanel({ target, query, stage: "searching", candidates: [], attempt: 1, errorCode: null });

    const result = await resolveBook(state.sessionId, query);
    if (!result.ok) {
      setPanel({
        target,
        query,
        stage: result.code === "NOT_FOUND_IN_ALADIN" ? "notFound" : "failed",
        candidates: [],
        attempt: 1,
        errorCode: result.code,
      });
      return;
    }

    const matched = result.data.candidates.find((item) => item.isbn13 === candidate.isbn13);
    if (matched === undefined) {
      void sendClientEvent({
        sessionId: state.sessionId,
        event: "book_resolved",
        properties: { resolve_attempt: 1, matched: false },
      });
      // 승격에 실패했다. 목록에 넣지 않고 재검색 경로로 되돌린다.
      setPanel({
        target,
        query,
        stage: "mismatch",
        candidates: result.data.candidates,
        attempt: 1,
        errorCode: null,
      });
      return;
    }

    promote(target, matched, 1);
  }

  /* ---------------------------------------------------------------- *
   * 기분 · 추천 (US-003 · US-004)
   * ---------------------------------------------------------------- */

  async function loadQuestions(current: SessionState) {
    const result = await fetchMoodQuestions(current.sessionId, toBookReferences(current));
    // 생성 실패·장애는 빈 배열로 흡수한다. 리듀서가 자유 입력으로 되돌리고
    // 세션은 끊기지 않는다 (API_SPEC /api/mood/questions).
    dispatch({
      type: "QUESTIONS_RECEIVED",
      questions: result.ok ? result.data.questions : [],
    });
  }

  function handleGuidedStart() {
    dispatch({ type: "GUIDED_MODE_ENTERED" });
    void loadQuestions(state);
  }

  /**
   * 세션 진행 상태를 요청에 싣는다. 무상태라 서버는 이 둘을 셀 수 없고, 그래서
   * 세는 쪽은 화면이고 판정하는 쪽은 서버다 (API_SPEC /api/recommend).
   *
   * **계약의 상한은 화면이 지킨다.** 두 값 모두 스키마 상한을 넘으면 400인데,
   * 400은 사용자에게 아무 의미가 없는 실패다. `irrelevantStreak`는
   * `nextIrrelevantCount`에 상한이 없어 3회째에 3이 되고, `retryIndex`는
   * `MAX_RECOMMEND_ATTEMPTS`(5)가 0-based 상한 4보다 하나 크므로 마지막
   * 재추천에서 5가 된다. 둘 다 보내기 직전에 클램프한다 — 서명이 아니라
   * 스키마가 상한을 강제하는 값이므로, 넘기지 않는 책임이 호출부에 있다 (ADR-006).
   *
   * `retryCount`를 인자로 여는 것은 **회복 재추천 때문**이다. `dispatch`는 비동기라
   * 이 함수가 보는 `state.recommendCount`는 아직 올라가기 전 값이고, 그대로 보내면
   * 리듀서가 센 횟수와 요청에 실린 값이 하나 어긋난다.
   */
  async function runRecommend(mood: string, inputMode: InputMode, retryCount = state.recommendCount) {
    const result = await requestRecommendations({
      sessionId: state.sessionId,
      books: toRecommendBooks(state),
      mood,
      inputMode,
      retryIndex: Math.min(retryCount, MAX_RETRY_INDEX),
      irrelevantStreak: Math.min(irrelevantCount, MAX_IRRELEVANT_STREAK),
    });

    if (result.ok) {
      setIrrelevantCount(0);
      dispatch({
        type: "RECOMMEND_SUCCEEDED",
        recommendations: result.data.recommendations,
        shortfall: result.data.shortfall,
      });
      return;
    }

    // 연속 횟수만 의미가 있다. 무관 판정이 아니면 0으로 되돌린다.
    setIrrelevantCount((count) => nextIrrelevantCount(count, result.code));
    dispatch({ type: "RECOMMEND_FAILED", code: result.code, requestId: result.requestId });
  }

  function handleMoodSubmit(mood: string) {
    dispatch({ type: "MOOD_SUBMITTED", mood });
    void runRecommend(mood, "free_text");
  }

  function handleAnswersSubmit(mood: string) {
    dispatch({ type: "ANSWERS_SUBMITTED", mood });
    void runRecommend(mood, "guided");
  }

  /**
   * error → recommending. **기분을 다시 묻지 않는다** — 직전 `mood`는 이미 상태에
   * 있고, 외부 장애 한 번에 사용자가 문장을 다시 쓰게 만들 이유가 없다
   * (ARCHITECTURE 상태 관리).
   *
   * 사진도 다시 올리지 않고 분석도 다시 하지 않는다. 이 경로가 없을 때 회복
   * 수단이 전체 재분석뿐이었던 것이 이 배선이 메우는 구멍이다.
   */
  function handleRecommendRetry() {
    if (state.status !== "error" || !canRecommendAgain(state)) return;

    const { mood, inputMode } = state;
    dispatch({ type: "RECOMMEND_RETRIED" });
    // 리듀서가 재추천 횟수를 올리므로 요청에도 올라간 값을 싣는다.
    void runRecommend(mood, inputMode, state.recommendCount + 1);
  }

  /**
   * North Star의 분자. **분모가 되는 추천 조회 이벤트는 여기서 보내지 않는다** —
   * `app/api/recommend/route.ts`가 이미 남기고 있어 양쪽이 보내면 이중 계상된다
   * (PRD 7번). `ClientEventPayload` 유니온이 그 이름을 표현하지 못하므로 타입이 막는다.
   */
  function handleAccept(bookId: string, position: 1 | 2 | 3) {
    void sendClientEvent({
      sessionId: state.sessionId,
      event: "recommend_accepted",
      properties: { position },
    });
  }

  function handleRestart() {
    // 사용자가 버리기로 한 작업이다. 타이머를 남기면 새 세션에서 유령 분석 호출이
    // 뜨고, 그 비용은 아무도 요청하지 않은 것이 된다.
    cancelRetryTimer();
    setPhotos([]);
    setAnalyzeAttempts(0);
    setPanel(null);
    dispatch({ type: "RESTARTED" });
  }

  /* ---------------------------------------------------------------- *
   * 렌더
   * ---------------------------------------------------------------- */

  if (state.status === "idle" || (state.status === "analyzing" && analyzeAttempts === 0)) {
    // 재시도가 아닌 분석 중에는 업로드 화면을 그대로 둔다. 여기서 언마운트하면
    // 사용자가 고른 사진과 썸네일이 화면에서 사라진다.
    return <UploadScreen onAnalyze={handleAnalyze} isAnalyzing={state.status === "analyzing"} />;
  }

  if (state.status === "analyzing") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="mx-auto w-full max-w-md space-y-2 px-4 py-6"
      >
        <p className="text-sm text-body">사진 {state.photoCount}장을 다시 읽고 있어요</p>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }

  if (state.status === "emptyShelf") {
    return (
      <div className="mx-auto w-full max-w-md space-y-4 px-4 py-10 text-center">
        <h1 className="text-2xl font-semibold text-ink">책등이 보이도록 다시 찍어 주세요</h1>
        <Notice>책장을 한 칸씩, 책등 글자가 정면으로 보이게 찍으면 잘 읽혀요</Notice>
        <button type="button" onClick={handleRestart} className={PRIMARY_BUTTON}>
          다시 찍기
        </button>
      </div>
    );
  }

  if (state.status === "error") {
    // 만료된 서명은 무엇을 다시 보내도 통과하지 못한다. 사진부터 다시 분석해야
    // 하므로 회복 CTA를 하나도 그리지 않는다 (ADR-006).
    const recoverable = state.errorCode !== "UNVERIFIED_BOOKS";
    // 나가는 문은 실패 **단계**가 고른다. 분석 실패에서 추천을 다시 부를 수 없고,
    // 추천 실패에서 사진을 다시 읽을 이유가 없다 (ARCHITECTURE 상태 관리).
    const fromAnalyze = recoverable && state.failedStage === "analyze";
    const fromRecommend = recoverable && state.failedStage === "recommend";
    const canRetryRecommend = fromRecommend && canRecommendAgain(state);
    const canRetryPhotos = fromAnalyze && canRetryAnalyze;

    return (
      <div className="mx-auto w-full max-w-md space-y-4 px-4 py-10">
        <ErrorBanner
          code={state.errorCode}
          // 응답 본문이 없었으면 null이다. "(없음)"을 지어내 넘기지 않는다.
          requestId={state.requestId}
          onRetry={canRetryPhotos ? () => handleRetryPhotos([]) : undefined}
          // 간격을 기다리는 동안은 감추지 않고 비활성으로 남긴다 (FR-010).
          retryDisabled={isWaitingRetry}
          onReset={handleRestart}
        />

        {/* 우리가 간격을 두는 것이지 사용자의 잘못이 아니다 — 경고색도
            role="alert"도 쓰지 않는다 (UI_GUIDE 안내 문구) */}
        {isWaitingRetry && <Notice>{retryWaitSec}초 뒤에 다시 시도할게요</Notice>}

        {fromRecommend && (
          <div className="flex items-center gap-3">
            {canRetryRecommend && (
              <button type="button" onClick={handleRecommendRetry} className={INLINE_SECONDARY_BUTTON}>
                같은 기분으로 다시 추천
              </button>
            )}
            <button
              type="button"
              onClick={() => dispatch({ type: "MOOD_REENTERED" })}
              className={TEXT_BUTTON}
            >
              기분 다시 입력
            </button>
          </div>
        )}

        {/* 재추천 몫을 다 쓴 뒤에는 버튼 대신 무엇을 하면 되는지 말한다 (UI_GUIDE 안내 문구) */}
        {fromRecommend && !canRetryRecommend && <Notice>기분을 바꿔 적어 보세요</Notice>}
        {fromAnalyze && !canRetryPhotos && <Notice>잠시 후 다시 시도해 주세요</Notice>}
      </div>
    );
  }

  if (state.status === "reviewing" || state.status === "unidentifiedOnly") {
    return (
      /* `failedPhotoCount`는 상태에 없다. 라우트가 언제나 `failedPhotoIndexes.length`로
         채우므로(`app/api/analyze/route.ts`) 여기서 같은 방식으로 되살린다. */
      <div className="mx-auto w-full max-w-md space-y-8 px-4 py-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold text-ink">책장을 이렇게 읽었어요</h1>
          <p className="text-sm text-body">알라딘에서 확인한 책만 추천 후보가 돼요</p>
        </header>

        {isWaitingRetry && <Notice>{retryWaitSec}초 뒤에 다시 시도할게요</Notice>}

        <BookList
          books={state.books}
          unidentified={state.unidentified}
          overflowCount={state.overflowCount}
          unidentifiedOverflowCount={state.unidentifiedOverflowCount}
          failedPhotoCount={state.failedPhotoIndexes.length}
          failedPhotoIndexes={state.failedPhotoIndexes}
          photoCount={state.photoCount}
          onResolve={openResolve}
          onSelectCandidate={(book, candidate) => void handleSelectCandidate(book, candidate)}
          onRetryLookup={handleRetryLookup}
          onRetryPhoto={handleRetryPhotos}
          retryPhotoDisabled={isWaitingRetry}
        />

        {panel !== null && (
          <ResolvePanelView
            panel={panel}
            onQueryChange={(query) => setPanel({ ...panel, query, stage: "input" })}
            onSearch={() => void runResolve(panel.target, panel.query, panel.attempt + 1)}
            onPick={(book) => promote(panel.target, book, panel.attempt)}
            onClose={() => setPanel(null)}
          />
        )}

        <div className="sticky bottom-0 space-y-2 border-t border-line bg-page pt-3 pb-4">
          {state.status === "reviewing" ? (
            <button
              type="button"
              onClick={() => dispatch({ type: "MOOD_STEP_ENTERED" })}
              className={PRIMARY_BUTTON}
            >
              추천받기
            </button>
          ) : (
            // 확인된 책이 0권이면 추천 CTA를 감춘다. 추천은 확인된 책 안에서만
            // 고르기 때문이다 (US-003 AC, ADR-002).
            <button type="button" onClick={handleRestart} className={SECONDARY_BUTTON}>
              다시 찍기
            </button>
          )}
        </div>
      </div>
    );
  }

  if (state.status === "guidedQuestions") {
    return (
      <GuidedQuestions
        questions={state.questions}
        // 질문이 아직 비어 있으면 요청이 진행 중이다. 빈 배열로 끝난 경우는
        // 리듀서가 이미 moodInput으로 되돌려 이 화면에 오지 않는다.
        isLoading={state.questions.length === 0}
        onSubmit={handleAnswersSubmit}
        onSkip={() => dispatch({ type: "GUIDED_SKIPPED" })}
      />
    );
  }

  if (state.status === "recommending" && state.inputMode === "guided") {
    return (
      <GuidedQuestions
        questions={state.questions}
        isSubmitting
        onSubmit={handleAnswersSubmit}
        onSkip={() => dispatch({ type: "GUIDED_SKIPPED" })}
      />
    );
  }

  if (state.status === "moodInput" || state.status === "recommending") {
    return (
      <MoodInput
        onSubmit={handleMoodSubmit}
        onGuidedStart={handleGuidedStart}
        irrelevantCount={irrelevantCount}
        isSubmitting={state.status === "recommending"}
        defaultMood={state.mood}
      />
    );
  }

  return (
    <div className="space-y-4">
      <RecommendationList
        recommendations={state.recommendations}
        books={books}
        shortfall={state.shortfall}
        canRecommendAgain={canRecommendAgain(state)}
        onAccept={handleAccept}
        onRecommendAgain={() => dispatch({ type: "RECOMMEND_AGAIN" })}
      />
      {/* 상태도의 result → idle. 추천 화면 안에 두지 않은 것은 step 4의 판단이다 */}
      <div className="mx-auto w-full max-w-md px-4 pb-8">
        <button type="button" onClick={handleRestart} className={TEXT_BUTTON}>
          새 사진으로 시작
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 조각
 * ------------------------------------------------------------------ */

const PRIMARY_BUTTON =
  "min-h-11 w-full rounded-md bg-accent px-5 py-3 text-white hover:bg-accent-strong";
const SECONDARY_BUTTON =
  "min-h-11 w-full rounded-md border border-line bg-card px-5 py-3 text-ink hover:bg-muted-surface";
const TEXT_BUTTON = "min-h-11 text-sm text-subtle underline underline-offset-2 hover:text-ink";
/** 에러 배너 옆에 나란히 서는 Secondary. 전폭이 아니라 내용 폭이다 (UI_GUIDE 버튼) */
const INLINE_SECONDARY_BUTTON =
  "min-h-11 rounded-md border border-line bg-card px-5 py-3 text-sm text-ink hover:bg-muted-surface";

interface ResolvePanelViewProps {
  panel: ResolvePanel;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  onPick: (book: ResolvedCandidate) => void;
  onClose: () => void;
}

/**
 * 제목을 고쳐 다시 찾는 패널 (US-002).
 *
 * 여기 나열되는 후보는 전부 `/api/books/resolve` 응답이라 `proof`를 갖고 있다.
 * 화면에 있던 `AladinCandidate`를 그대로 고르는 경로는 존재하지 않는다.
 */
function ResolvePanelView({
  panel,
  onQueryChange,
  onSearch,
  onPick,
  onClose,
}: ResolvePanelViewProps) {
  const searching = panel.stage === "searching";

  return (
    <section className="space-y-3 rounded-sm border border-line bg-muted-surface p-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-ink">제목을 고쳐 다시 찾기</h2>
        <p className="font-mono text-sm text-body">{panel.target.rawText}</p>
      </div>

      <label htmlFor="resolve-query" className="block text-sm text-body">
        책 제목
      </label>
      <input
        id="resolve-query"
        value={panel.query}
        maxLength={MAX_RESOLVE_QUERY_LENGTH}
        onChange={(event) => onQueryChange(event.target.value)}
        className="w-full rounded-md border border-line bg-card px-4 py-3 text-ink placeholder:text-disabled focus:border-accent focus:outline-none"
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSearch}
          disabled={searching || panel.query.trim().length === 0}
          className="min-h-11 rounded-md bg-accent px-5 py-3 text-sm text-white hover:bg-accent-strong disabled:bg-card disabled:text-disabled"
        >
          재검색
        </button>
        <button type="button" onClick={onClose} className={TEXT_BUTTON}>
          닫기
        </button>
      </div>

      {searching && (
        <div role="status" aria-live="polite" className="space-y-2">
          <p className="text-sm text-body">알라딘에서 찾고 있어요</p>
          <Skeleton className="h-4 w-32" />
        </div>
      )}

      {/* 고른 책을 서명과 함께 다시 받아 오지 못했다. 목록에 넣지 않는다 (ADR-006) */}
      {panel.stage === "mismatch" && (
        <Notice>고른 책을 다시 확인하지 못했어요. 아래에서 다시 골라 주세요</Notice>
      )}

      {panel.stage === "notFound" && (
        <Notice>알라딘에서 찾을 수 없는 책이에요 (원서·절판일 수 있어요)</Notice>
      )}

      {/* 조회 실패는 데이터 문제가 아니다. 절판·원서 안내를 쓰지 않는다 (ADR-005) */}
      {panel.stage === "failed" && (
        <Notice>지금 확인할 수 없었어요. 잠시 후 다시 시도해 주세요</Notice>
      )}

      {panel.candidates.length > 0 && (
        <ul className="space-y-2">
          {panel.candidates.map((candidate) => (
            <li key={candidate.isbn13}>
              <button
                type="button"
                onClick={() => onPick(candidate)}
                className="flex min-h-11 w-full items-center gap-3 rounded-md border border-line bg-card p-3 text-left hover:bg-muted-surface"
              >
                <BookCover
                  coverUrl={candidate.coverUrl}
                  title={candidate.title}
                  className="w-10"
                />
                <span className="min-w-0">
                  <span title={candidate.title} className="line-clamp-2 block text-sm text-ink">
                    {candidate.title}
                  </span>
                  <span className="line-clamp-1 block text-xs text-subtle">
                    {candidate.author} · {candidate.publisher}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
