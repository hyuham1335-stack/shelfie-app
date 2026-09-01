/**
 * 세션 상태 리듀서 (ARCHITECTURE "상태 관리").
 *
 * ## 왜 React 밖에 있는가
 * 화면 전이 규칙은 React와 무관한 규칙이다. 리듀서를 컴포넌트 안에 두면 전이를
 * 렌더링을 통해서만 검사할 수 있고, 그러면 "분석 실패 후 재시도하면 어디로 가는가"
 * 같은 질문에 jsdom과 가짜 DOM 이벤트가 끼어든다. 그래서 이 파일에는 `fetch`도,
 * React import도, 브라우저 API도 없다. 순수 함수뿐이다.
 *
 * ## 정의되지 않은 전이는 던지지 않고 상태를 그대로 돌려준다
 * 느린 네트워크에서 버튼을 두 번 누르는 것은 예외 상황이 아니라 평범한 일이다.
 * 상태도에 없는 (상태, 액션) 조합은 무시하고 같은 참조를 반환한다 — 던지면
 * 화면이 죽고, 임의로 전이시키면 상태도가 문서가 아니라 장식이 된다.
 *
 * ## 저장하지 않는다
 * `localStorage`·쿠키에 세션을 남기지 않는다. 새로고침 시 소실은 무상태 설계의
 * 의도된 결과이며(ADR-003), 재추천 상한을 저장소로 지키려는 시도는 그 전제를
 * 문서 없이 우회하는 것이다.
 */
import { MAX_IDENTIFIED_BOOKS } from "./env";
import type { AnalyzeResponse, ErrorCode, MoodQuestion, Recommendation } from "@/types/api";
import type {
  BookReference,
  IdentifiedBook,
  RecommendBook,
  ResolvedCandidate,
  UnidentifiedBook,
} from "@/types/book";

/**
 * "다시 추천받기" 상한 (FR-010). 남용 방어가 아니라 실수로 인한 비용 누수를
 * 막는 장치이므로 서버가 강제하지 않고 여기서 센다 — 무상태라 서버에
 * 세션별 카운터를 둘 수 없다 (API_SPEC `/api/recommend`).
 */
export const MAX_RECOMMEND_ATTEMPTS = 5;

/** 기분 텍스트의 최소 길이. 공백 제거 후 2자 미만이면 문답으로 분기한다 (FR-007) */
const MIN_MOOD_LENGTH = 2;

/* ------------------------------------------------------------------ *
 * 책장에 올라온 책
 * ------------------------------------------------------------------ */

/**
 * 확인된 책 1권. 알라딘 대조와 `proof`를 통과했다는 점에서는 같지만
 * **출처가 다르다**.
 *
 * - `photo`   : 사진에서 판독돼 `/api/analyze`가 확인한 책. `photoIndex`와
 *               Claude 한줄평(`claudeNote`)을 갖는다.
 * - `resolved`: 사용자가 제목을 고쳐 `/api/books/resolve`로 찾아낸 책.
 *               `photoIndex`가 **없다** — 사진이 아니라 재검색에서 왔기 때문이고,
 *               없는 값을 `0`으로 지어내는 것은 출처를 위조하는 것이다
 *               (ARCHITECTURE 상태 관리). `claudeNote`도 없다.
 *
 * 요청 경계에서 쓰는 `bookReferenceSchema`·`recommendBookSchema`가 `photoIndex`를
 * 요구하지 않으므로 계약을 바꿀 이유도 없다.
 */
export type ShelfBook =
  | { origin: "photo"; book: IdentifiedBook }
  | { origin: "resolved"; book: ResolvedCandidate };

/** 기분 입력 경로. 이벤트 로그 속성으로만 쓴다 (API_SPEC `/api/recommend`) */
export type InputMode = "free_text" | "guided";

/* ------------------------------------------------------------------ *
 * 상태
 * ------------------------------------------------------------------ */

/** ARCHITECTURE 상태도의 10개 화면 상태 */
export type SessionStatus =
  | "idle"
  | "analyzing"
  | "reviewing"
  | "unidentifiedOnly"
  | "emptyShelf"
  | "moodInput"
  | "guidedQuestions"
  | "recommending"
  | "result"
  | "error";

/** 상태와 무관하게 세션이 들고 다니는 값 */
interface SessionData {
  /**
   * 밖에서 주입받는다. 리듀서가 `crypto.randomUUID()`를 부르면 같은 입력에
   * 같은 출력이 아니게 된다.
   */
  sessionId: string;
  /**
   * 업로드한 사진 장수. `/api/analyze` 응답에 없으므로 상태가 들고 있어야 한다 —
   * 부분 실패 배너("사진 3장 중 1장은 읽지 못했어요")의 **분모**다.
   */
  photoCount: number;
  books: ShelfBook[];
  unidentified: UnidentifiedBook[];
  overflowCount: number;
  unidentifiedOverflowCount: number;
  /** 실패한 사진의 0-based 인덱스. 그 사진만 골라 재시도하기 위한 값 */
  failedPhotoIndexes: number[];
  mood: string;
  inputMode: InputMode;
  questions: MoodQuestion[];
  recommendations: Recommendation[];
  shortfall: boolean;
  /** 재추천 횟수. `MAX_RECOMMEND_ATTEMPTS`에 걸리면 더 못 누른다 (FR-010) */
  recommendCount: number;
  /** 화면이 읽는 실패 사유. `error` 상태에서는 반드시 채워져 있다 */
  errorCode: ErrorCode | null;
  /** 에러 배너가 노출하는 상관관계 ID (UI_GUIDE 에러 배너, TRD 6.4) */
  requestId: string | null;
}

type WithStatus<S extends SessionStatus, Extra = unknown> = SessionData & { status: S } & Extra;

/**
 * 화면 상태로 판별하는 유니온.
 *
 * `error`만 추가 제약을 갖는다 — 그 상태에서 `errorCode`가 `null`이면 배너가
 * 아무 문구도 고를 수 없으므로, 타입 수준에서 비어 있을 수 없게 한다.
 */
export type SessionState =
  | WithStatus<"idle">
  | WithStatus<"analyzing">
  | WithStatus<"reviewing">
  | WithStatus<"unidentifiedOnly">
  | WithStatus<"emptyShelf">
  | WithStatus<"moodInput">
  | WithStatus<"guidedQuestions">
  | WithStatus<"recommending">
  | WithStatus<"result">
  | WithStatus<"error", { errorCode: ErrorCode }>;

/* ------------------------------------------------------------------ *
 * 액션 — 이름은 ARCHITECTURE 상태도의 전이 라벨을 따른다
 * ------------------------------------------------------------------ */

export type SessionAction =
  /** idle → analyzing (사진 선택 후 분석 시작) */
  | { type: "ANALYZE_STARTED"; photoCount: number }
  /** unidentifiedOnly·error → analyzing (실패한 사진만 재시도) */
  | { type: "ANALYZE_RETRIED"; photoCount: number }
  /** analyzing → reviewing | unidentifiedOnly */
  | { type: "ANALYZE_SUCCEEDED"; result: AnalyzeResponse }
  /** analyzing → emptyShelf(EMPTY_SHELF) | error */
  | { type: "ANALYZE_FAILED"; code: ErrorCode; requestId: string | null }
  /** unidentifiedOnly → reviewing, reviewing → reviewing (미확인 책 수정·재검색) */
  | { type: "BOOK_RESOLVED"; rawText: string; book: ResolvedCandidate }
  /** reviewing → moodInput (추천 단계로 이동) */
  | { type: "MOOD_STEP_ENTERED" }
  /** moodInput → guidedQuestions (기분을 비운 채 진행) */
  | { type: "GUIDED_MODE_ENTERED" }
  /** guidedQuestions → guidedQuestions(질문 수신) | moodInput(생성 실패 폴백) */
  | { type: "QUESTIONS_RECEIVED"; questions: MoodQuestion[] }
  /** guidedQuestions → moodInput (문답 건너뛰기) */
  | { type: "GUIDED_SKIPPED" }
  /** moodInput → recommending (기분 텍스트 제출) */
  | { type: "MOOD_SUBMITTED"; mood: string }
  /** guidedQuestions → recommending (답변 제출) */
  | { type: "ANSWERS_SUBMITTED"; mood: string }
  /** recommending → result */
  | { type: "RECOMMEND_SUCCEEDED"; recommendations: Recommendation[]; shortfall: boolean }
  /** recommending → moodInput(무관한 입력·검증 실패) | error(외부 API 오류) */
  | { type: "RECOMMEND_FAILED"; code: ErrorCode; requestId: string | null }
  /** result → moodInput (다시 추천받기) */
  | { type: "RECOMMEND_AGAIN" }
  /** emptyShelf·unidentifiedOnly·result·error → idle (다시 찍기 · 처음으로) */
  | { type: "RESTARTED" };

/* ------------------------------------------------------------------ *
 * 초기 상태
 * ------------------------------------------------------------------ */

/**
 * `sessionId`는 밖에서 만들어 넣는다. 이 파일이 UUID를 생성하면 같은 입력에
 * 같은 출력이 아니게 되어 전이 규칙을 값으로 검사할 수 없다.
 */
export function createSessionState(sessionId: string): SessionState {
  return {
    status: "idle",
    sessionId,
    ...EMPTY_SESSION_DATA,
    recommendCount: 0,
  };
}

/** 세션을 처음으로 되돌릴 때 초기화되는 값. `sessionId`와 재추천 횟수는 여기 없다 */
const EMPTY_SESSION_DATA = {
  photoCount: 0,
  books: [] as ShelfBook[],
  unidentified: [] as UnidentifiedBook[],
  overflowCount: 0,
  unidentifiedOverflowCount: 0,
  failedPhotoIndexes: [] as number[],
  mood: "",
  inputMode: "free_text" as InputMode,
  questions: [] as MoodQuestion[],
  recommendations: [] as Recommendation[],
  shortfall: false,
  errorCode: null,
  requestId: null,
} satisfies Omit<SessionData, "sessionId" | "recommendCount">;

/* ------------------------------------------------------------------ *
 * 리듀서
 * ------------------------------------------------------------------ */

export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "ANALYZE_STARTED":
      // 상태도에서 analyzing으로 들어오는 첫 경로는 idle뿐이다.
      if (state.status !== "idle") return state;
      return startAnalyzing(state, action.photoCount);

    case "ANALYZE_RETRIED":
      // 실패한 사진만 다시 시도한다. 응답이 전체를 다시 채우므로 이전 결과는 버린다 —
      // 이 두 상태에서 확인된 책은 0권이거나(unidentifiedOnly) 아직 없다(error).
      if (state.status !== "unidentifiedOnly" && state.status !== "error") return state;
      return startAnalyzing(state, action.photoCount);

    case "ANALYZE_SUCCEEDED": {
      if (state.status !== "analyzing") return state;
      const { result } = action;
      const books: ShelfBook[] = result.identified.map((book) => ({ origin: "photo", book }));
      const next = {
        ...state,
        books,
        unidentified: result.unidentified,
        overflowCount: result.overflowCount,
        unidentifiedOverflowCount: result.unidentifiedOverflowCount,
        failedPhotoIndexes: result.failedPhotoIndexes,
        errorCode: null,
        requestId: null,
      };
      // 후보는 있었으나 확인 0건인 경우는 빈 상태가 아니다. 미확인 목록과 사유를
      // 그대로 보여주는 별도 화면으로 간다 (API_SPEC `/api/analyze`).
      return books.length > 0
        ? { ...next, status: "reviewing" }
        : { ...next, status: "unidentifiedOnly" };
    }

    case "ANALYZE_FAILED": {
      if (state.status !== "analyzing") return state;
      // 추출 후보 자체가 0건일 때만 빈 상태다. 그 외는 재시도 가능한 실패다.
      if (action.code === "EMPTY_SHELF") {
        return {
          ...state,
          status: "emptyShelf",
          errorCode: action.code,
          requestId: action.requestId,
        };
      }
      return { ...state, status: "error", errorCode: action.code, requestId: action.requestId };
    }

    case "BOOK_RESOLVED": {
      if (state.status !== "reviewing" && state.status !== "unidentifiedOnly") return state;

      const alreadyOnShelf = state.books.some((entry) => entry.book.isbn13 === action.book.isbn13);
      // 상한에 걸렸는데 미확인 항목만 지우면 사용자가 고른 책이 조용히 사라진다.
      // 아무것도 하지 않고 원문을 화면에 남겨 두는 편이 정직하다 (FR-005).
      if (!alreadyOnShelf && state.books.length >= MAX_IDENTIFIED_BOOKS) return state;

      const index = state.unidentified.findIndex((book) => book.rawText === action.rawText);
      if (index === -1) return state;

      const unidentified = [...state.unidentified];
      unidentified.splice(index, 1);
      const books: ShelfBook[] = alreadyOnShelf
        ? state.books
        : [...state.books, { origin: "resolved", book: action.book }];

      return { ...state, status: "reviewing", books, unidentified };
    }

    case "MOOD_STEP_ENTERED":
      // 확인된 책이 0권이면 추천 단계로 갈 수 없다 — 추천은 확인된 책 안에서만
      // 고르기 때문이다 (ADR-002, US-003).
      if (state.status !== "reviewing" || state.books.length === 0) return state;
      return { ...state, status: "moodInput", errorCode: null, requestId: null };

    case "GUIDED_MODE_ENTERED":
      if (state.status !== "moodInput") return state;
      return {
        ...state,
        status: "guidedQuestions",
        inputMode: "guided",
        questions: [],
        errorCode: null,
        requestId: null,
      };

    case "QUESTIONS_RECEIVED":
      if (state.status !== "guidedQuestions") return state;
      // 빈 배열은 생성 실패·모델 장애를 흡수한 값이다. 세션을 끊지 않고 자유
      // 입력으로 되돌린다 (API_SPEC `/api/mood/questions`).
      if (action.questions.length === 0) {
        return { ...state, status: "moodInput", inputMode: "free_text", questions: [] };
      }
      return { ...state, questions: action.questions };

    case "GUIDED_SKIPPED":
      if (state.status !== "guidedQuestions") return state;
      return { ...state, status: "moodInput", inputMode: "free_text", questions: [] };

    case "MOOD_SUBMITTED": {
      if (state.status !== "moodInput") return state;
      const mood = action.mood.trim();
      // 공백 제거 후 2자 미만이면 추천으로 진행하지 않는다. 빈 입력의 목적지는
      // 문답이며(FR-007), 그쪽은 GUIDED_MODE_ENTERED가 담당한다.
      if (mood.length < MIN_MOOD_LENGTH) return state;
      return {
        ...state,
        status: "recommending",
        mood,
        inputMode: "free_text",
        errorCode: null,
        requestId: null,
      };
    }

    case "ANSWERS_SUBMITTED": {
      if (state.status !== "guidedQuestions") return state;
      const mood = action.mood.trim();
      if (mood.length < MIN_MOOD_LENGTH) return state;
      return {
        ...state,
        status: "recommending",
        mood,
        inputMode: "guided",
        errorCode: null,
        requestId: null,
      };
    }

    case "RECOMMEND_SUCCEEDED":
      if (state.status !== "recommending") return state;
      return {
        ...state,
        status: "result",
        recommendations: action.recommendations,
        shortfall: action.shortfall,
        errorCode: null,
        requestId: null,
      };

    case "RECOMMEND_FAILED":
      if (state.status !== "recommending") return state;
      // 무관한 입력(422)과 추천 검증 실패는 기분을 다시 받는 것으로 회복된다.
      // 그 외(외부 장애·타임아웃·서명 실패·우리 결함)는 재시도 화면으로 보낸다.
      if (action.code === "IRRELEVANT_MOOD" || action.code === "RECOMMENDATION_VALIDATION_FAILED") {
        return {
          ...state,
          status: "moodInput",
          errorCode: action.code,
          requestId: action.requestId,
        };
      }
      return { ...state, status: "error", errorCode: action.code, requestId: action.requestId };

    case "RECOMMEND_AGAIN": {
      if (state.status !== "result") return state;
      // 상한을 넘긴 클릭은 무시한다. 버튼은 화면에서 이미 비활성이지만, 상한을
      // 화면에만 두면 규칙이 렌더링에 의존하게 된다 (FR-010).
      if (!canRecommendAgain(state)) return state;
      return {
        ...state,
        status: "moodInput",
        recommendCount: state.recommendCount + 1,
        recommendations: [],
        shortfall: false,
        errorCode: null,
        requestId: null,
      };
    }

    case "RESTARTED":
      if (
        state.status !== "emptyShelf" &&
        state.status !== "unidentifiedOnly" &&
        state.status !== "result" &&
        state.status !== "error"
      ) {
        return state;
      }
      // 재추천 횟수는 초기화하지 않는다. FR-010의 상한은 **세션당**이고,
      // "새 사진으로 시작"으로 카운터가 풀리면 상한이 사실상 없어진다.
      return {
        status: "idle",
        sessionId: state.sessionId,
        recommendCount: state.recommendCount,
        ...EMPTY_SESSION_DATA,
      };

    default:
      return state;
  }
}

/** analyzing 진입은 두 경로가 있지만 하는 일이 같다 — 이전 결과를 비우고 장수를 기록한다 */
function startAnalyzing(state: SessionState, photoCount: number): SessionState {
  if (!Number.isInteger(photoCount) || photoCount < 1) return state;
  return {
    status: "analyzing",
    sessionId: state.sessionId,
    recommendCount: state.recommendCount,
    ...EMPTY_SESSION_DATA,
    photoCount,
  };
}

/* ------------------------------------------------------------------ *
 * 셀렉터 — 요청 경계에서 쓰는 최소 형태와 화면 판정
 * ------------------------------------------------------------------ */

/**
 * `/api/mood/questions` 요청용 최소 형태 (`bookReferenceSchema`).
 * `proof`가 빠지면 서버는 이 목록이 자기가 내준 것인지 알 수 없다 (ADR-006).
 */
export function toBookReferences(state: SessionState): BookReference[] {
  return state.books.map(({ book }) => ({
    isbn13: book.isbn13,
    title: book.title,
    author: book.author,
    proof: book.proof,
  }));
}

/**
 * `/api/recommend` 요청용 최소 형태 (`recommendBookSchema`).
 *
 * 승격된 책에는 한줄평이 없으므로 빈 문자열로 채운다 — 스키마가 허용하는 값이고,
 * 화면에서는 **한줄평 블록 자체를 그리지 않는다.** 빈 `ClaudeText`를 그리면
 * Claude가 아무 말도 안 한 것을 말한 것처럼 만든다 (UI_GUIDE 원칙 2).
 */
export function toRecommendBooks(state: SessionState): RecommendBook[] {
  return state.books.map((entry) => ({
    isbn13: entry.book.isbn13,
    title: entry.book.title,
    author: entry.book.author,
    pages: entry.book.pages,
    claudeNote: entry.origin === "photo" ? entry.book.claudeNote : "",
    proof: entry.book.proof,
  }));
}

/** "다시 추천받기"를 더 누를 수 있는가 (FR-010) */
export function canRecommendAgain(state: SessionState): boolean {
  return state.recommendCount < MAX_RECOMMEND_ATTEMPTS;
}

/** 확인된 책이 1권 이상인가. 0권이면 추천 단계로 넘어가지 않는다 */
export function hasVerifiedBooks(state: SessionState): boolean {
  return state.books.length > 0;
}
