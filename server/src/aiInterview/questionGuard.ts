// 질문 grounding "코드 가드".
//
// LLM 이 생성한 question/basis 가 허용 근거에서 너무 벗어났는지 가볍게 검사한다.
//  - main 질문 근거: resumeText
//  - followup 질문 근거: resumeText + 직전 answer + evaluation.rationale
//
// 형태소 분석기 없이 토큰 단위 substring 매칭으로만 동작한다(외부 의존성 0).
// 설계 원칙(요구사항 #5): "너무 엄격하게 막지 않는다".
//  - 강하게 잡는 것: 근거에 없는 기술명·고유명사·KPI·수치 (latin 토큰 / 숫자 토큰).
//  - 느슨하게 두는 것: "문제 해결 방식", "구현 과정", "설계 기준" 같은 일반 면접 한국어 표현.
//    → 한국어 토큰은 "검사 대상 핵심어가 3개 이상인데 그중 단 하나도 근거에 없을 때"만 일탈로 본다.

/** 일반 면접/기능어 — 검사 대상에서 제외(이력서에 없어도 통과). */
const GENERIC_STOPWORDS = new Set<string>([
  "설명", "구체적", "구체", "경험", "역할", "과정", "결과", "기준", "문제", "해결",
  "방식", "방법", "구현", "설계", "내용", "부분", "상황", "본인", "지원자", "면접",
  "면접관", "질문", "답변", "자신", "가장", "직접", "어떤", "어떻게", "무엇", "어디",
  "누구", "관련", "대해", "대한", "위해", "통해", "진행", "수행", "담당", "사용",
  "활용", "적용", "생각", "의도", "이유", "정도", "다음", "이번", "당시", "측면",
  "관점", "영향", "효과", "차이", "그것", "이것", "무언가", "어려웠던", "있는지",
  "주세요", "말씀", "각각", "여러", "모든", "또한", "그리고", "하지만", "예시", "예를",
]);

/** 일반 영어 단어 — latin 토큰이라도 검사에서 제외. */
const GENERIC_LATIN = new Set<string>([
  "ai", "it", "or", "and", "the", "vs", "etc", "ok", "an", "of", "to", "in", "on", "for",
]);

/**
 * 한국어 토큰 꼬리(조사 + 흔한 용언 활용/"하다"형)를 1회만 떼어 명사 어간에 가깝게 만든다.
 * 가장 긴 접미사부터 시도하고, 떼고 남은 길이가 2 미만이면 떼지 않는다.
 * (substring 매칭이므로 살짝 짧게 깎이는 쪽이 더 관대해져 오탐을 줄인다.)
 */
const KO_SUFFIXES = [
  "하였습니다", "했었습니다", "하겠습니다", "했습니다", "이라는", "으로는", "에서는",
  "했나요", "하나요", "했는지", "하는지", "입니다", "습니다", "했었다", "하였다",
  "에서", "에게", "으로", "처럼", "까지", "부터", "조차", "마저", "에는", "과의", "와의",
  "했고", "하고", "하며", "하면", "하여", "해서", "했다", "한다", "하기", "하는",
  "된다", "되는", "됐다", "됨", "함", "의", "을", "를", "이", "가", "은", "는", "에",
  "와", "과", "도", "만", "로", "나", "랑", "고", "며", "면", "서", "지", "게", "해",
  "한", "할", "된", "돼",
].sort((a, b) => b.length - a.length);

function stripKoreanSuffix(token: string): string {
  for (const suf of KO_SUFFIXES) {
    if (token.length > suf.length && token.endsWith(suf) && token.length - suf.length >= 2) {
      return token.slice(0, token.length - suf.length);
    }
  }
  return token;
}

export type KeywordKind = "latin" | "numeric" | "korean";
export interface Keyword {
  /** 매칭에 쓰는 표면형(latin/numeric 은 원형, korean 은 어간). */
  text: string;
  kind: KeywordKind;
}

/** question + basis(또는 임의 텍스트)에서 "검사 대상 핵심 키워드"만 추출한다(일반어 제외). */
export function extractKeywords(text: string): Keyword[] {
  const out: Keyword[] = [];
  const seen = new Set<string>();
  const push = (raw: string, kind: KeywordKind) => {
    if (!raw) return;
    const key = `${kind}:${raw.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: raw, kind });
  };

  // 1) 숫자 토큰: 수치·단위·% (예: 420ms, 12%, 1.8초, 91%). 강한 신호.
  //    단위만 붙이고 조사(로/까지/에서…)는 포함하지 않는다 — 안 그러면 "420ms로" 가 "420ms" 와 매칭되지 않는다.
  const NUM_UNIT = "%|[A-Za-z]+|초|분|시간|일|주|개월|년|배|명|건|원|개|위|등|점|만|억|천|밀리초";
  for (const m of text.match(new RegExp(`\\d[\\d.,]*(?:${NUM_UNIT})?`, "g")) ?? []) {
    const t = stripKoreanSuffix(m.replace(/[.,]+$/, ""));
    if (/\d/.test(t)) push(t, "numeric");
  }

  // 2) latin/기술 토큰 (예: LangGraph, React, TypeScript, API, KPI, A/B). 길이 3 이상만 강한 신호로 본다.
  for (const m of text.match(/[A-Za-z][A-Za-z0-9+./-]*/g) ?? []) {
    const t = m.replace(/[./-]+$/, "");
    if (t.length < 3) continue; // UI, DB 같은 2글자 약어는 노이즈라 제외
    if (/\d/.test(t)) continue; // 숫자 포함은 numeric 에서 처리
    if (GENERIC_LATIN.has(t.toLowerCase())) continue;
    push(t, "latin");
  }

  // 3) 한국어 토큰: 어간으로 정규화 후 일반어 제외. (약한 신호 — ratio 규칙에서만 사용)
  for (const m of text.match(/[가-힣]{2,}/g) ?? []) {
    const stem = stripKoreanSuffix(m);
    if (stem.length < 2) continue;
    if (GENERIC_STOPWORDS.has(stem)) continue;
    push(stem, "korean");
  }

  return out;
}

export interface GroundingResult {
  /** 근거에서 벗어났다고 판단되면 true. */
  drifted: boolean;
  /** 검사한 핵심 키워드 전체. */
  checked: string[];
  /** 근거를 찾지 못한 키워드(로그/재생성 힌트용). */
  ungrounded: string[];
}

/**
 * question/basis 의 핵심 키워드가 sources(허용 근거)에 등장하는지 검사한다.
 * 일탈 판정:
 *  - 근거에 없는 "강한 키워드"(숫자, 길이 3+ latin/기술명)가 하나라도 있으면 일탈, 또는
 *  - 한국어 핵심어가 3개 이상인데 그중 단 하나도 근거에 없으면 일탈.
 */
export function checkQuestionGrounding(
  question: string,
  basis: string,
  sources: string[]
): GroundingResult {
  const haystack = sources.join("\n").toLowerCase();
  const keywords = extractKeywords(`${question} ${basis}`);

  const has = (k: Keyword) => haystack.includes(k.text.toLowerCase());

  const ungrounded: string[] = [];
  const korean: Keyword[] = [];
  const strongUngrounded: string[] = [];
  let koreanGrounded = 0;

  for (const k of keywords) {
    const grounded = has(k);
    if (!grounded) ungrounded.push(k.text);
    if (k.kind === "korean") {
      korean.push(k);
      if (grounded) koreanGrounded += 1;
    } else if (!grounded) {
      // numeric 또는 latin(길이 3+) = 강한 신호
      strongUngrounded.push(k.text);
    }
  }

  const drifted =
    strongUngrounded.length >= 1 || (korean.length >= 3 && koreanGrounded === 0);

  return { drifted, checked: keywords.map((k) => k.text), ungrounded };
}

/**
 * resumeText 에서 fallback 질문에 끼울 "실제로 적힌" 앵커(프로젝트/기술명)를 고른다.
 * latin 고유명사(InterviewForge, LangGraph 등) 중 가장 긴 것을 우선한다. 없으면 null.
 */
export function pickResumeAnchor(resumeText: string): string | null {
  const latin = (resumeText.match(/[A-Za-z][A-Za-z0-9+./-]*/g) ?? [])
    .map((t) => t.replace(/[./-]+$/, ""))
    .filter((t) => t.length >= 3 && !/\d/.test(t) && !GENERIC_LATIN.has(t.toLowerCase()));
  if (latin.length === 0) return null;
  // CamelCase(고유명사 가능성↑) → 길이 순으로 가장 그럴듯한 것 선택.
  latin.sort((a, b) => {
    const ca = /[A-Z]/.test(a.slice(1)) ? 1 : 0;
    const cb = /[A-Z]/.test(b.slice(1)) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return b.length - a.length;
  });
  return latin[0] ?? null;
}
