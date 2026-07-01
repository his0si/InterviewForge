// 이력서 "주제(topic)" 카탈로그 — 같은 경험을 반복해서 묻지 않도록 코드 레벨에서 관리한다.
//
// 배경(요구사항 #1):
//  - LLM 은 하나의 프로젝트/경험을 "구체성·논리성·역할·결과"처럼 검증 관점만 바꿔 계속 캐묻는 경향이 있다.
//  - 검증 관점이 달라진 것은 "새 주제"가 아니다. 같은 프로젝트·경험·기능은 메인 질문 기준 최대 2개까지만 허용한다.
//  - 이 판단을 프롬프트 지시에만 맡기지 않고, resumeText 에서 "주제 카탈로그"를 추출해 코드에서 강제한다.
//
// 설계:
//  - extractResumeTopics(resumeText): resumeText(특히 [프로젝트 경험])에서 주제 후보를 뽑는다.
//    각 주제는 대표 앵커(기술명/도메인 키워드)를 key 로 갖는다(예: "langgraph", "react", "t-크롤링").
//    표현만 다른 유사 질문도 같은 앵커를 공유하므로 같은 주제로 묶인다.
//  - classifyQuestionTopic(question, basis, topics): 생성된 질문이 어느 주제에 속하는지 코드로 판정한다.
//  - 형태소 분석기 없이 questionGuard 의 키워드 추출(extractKeywords)을 재사용한다(외부 의존성 0).

import { extractKeywords, type Keyword } from "./questionGuard.js";

export interface ResumeTopic {
  /** 코드에서 주제를 식별하는 안정적인 키(예: "langgraph", "t-크롤링"). */
  key: string;
  /** 사람이 읽는 라벨(프롬프트의 제외 목록·안전 질문에 그대로 노출). resumeText 의 실제 문장 일부. */
  label: string;
  /** 이 주제를 가리키는 시그니처 키워드(소문자). 질문 분류 시 겹침을 본다. */
  keywords: string[];
}

/** "[프로젝트 경험]" 같은 섹션 헤더 한 줄. */
const SECTION_HEADER = /^\s*\[[^\]]+\]\s*$/;

/**
 * URL/링크를 제거한다. PDF 추출 이력서에는 포트폴리오·프로젝트 링크가 많은데,
 * 토큰 추출기가 "heeseokim.o-r.kr/projects/..." 같은 URL 경로를 가장 긴 latin 토큰으로 보고
 * 주제 앵커로 잡아 서로 다른 프로젝트가 한 주제로 뭉치는 문제가 있다. 주제 추출 전에 걷어낸다.
 *  - http(s):// 토큰, "Link:" 라벨, "도메인(/경로)" 형태의 맨몸 URL 까지 제거.
 */
function stripUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\bLink\s*:/gi, " ")
    .replace(/\b[\w.-]+\.(?:com|kr|io|org|net|dev|ai|co|me|app)(?:\/\S*)?/gi, " ");
}

/**
 * 텍스트를 "경험 단위"로 쪼갠다.
 *  - PDF 추출 이력서는 줄바꿈이 거의 없는 한 덩어리인 경우가 많아 줄 단위 분리만으로는
 *    전체가 한 주제로 뭉친다. 그래서 줄바꿈 + 문장끝(마침표+공백) + 날짜 항목 + 스택/섹션 라벨
 *    경계에서도 함께 끊어 프로젝트마다 별도 단위가 되도록 한다.
 *  - "React.js" 처럼 토큰 내부의 마침표는 끊지 않는다(마침표 뒤가 공백일 때만 분리).
 */
function splitUnits(text: string): string[] {
  const withBreaks = text
    // 날짜 항목("2025.8~", "2024.3", "2026.1") 앞에서 끊기 — 프로젝트/경력 항목의 시작 신호.
    .replace(/\s(?=20\d\d\s*[.년]\s*\d{1,2})/g, "\n")
    // 스택/역할/섹션 라벨 앞에서 끊기.
    .replace(/\s(?=(?:Backend|Frontend|AI\/ML|Infra|Skills|Awards|Experience|Education|Certifications|Publications|Intern|Startup)\s*[:：])/gi, "\n")
    // 문장 끝(마침표/물음표/느낌표 + 공백)에서 끊기. 토큰 내부 마침표(React.js)는 제외.
    .replace(/([.!?])\s+/g, "$1\n");
  return withBreaks.split(/\r?\n/);
}

/** 줄 앞의 글머리표/번호("1)", "-", "·", "(1)")를 제거한다. */
function cleanLine(line: string): string {
  return line.replace(/^\s*(?:\d+[).．.]|[-*·•▪◦]|\([^)]*\))\s*/, "").trim();
}

/**
 * resumeText 에서 "[프로젝트 경험]" 섹션만 잘라낸다(주제 추출의 주 대상).
 * 헤더가 없거나 내용이 비면 전체 텍스트를 돌려준다.
 */
function projectSection(resumeText: string): string {
  const lines = resumeText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => /\[?\s*프로젝트\s*경험/.test(l));
  if (startIdx === -1) return resumeText;
  const rest = lines.slice(startIdx + 1);
  const endRel = rest.findIndex((l) => SECTION_HEADER.test(l));
  const section = (endRel === -1 ? rest : rest.slice(0, endRel)).join("\n").trim();
  return section || resumeText;
}

/**
 * 한 줄(경험 단위)의 "대표 앵커"를 고른다.
 *  - 1순위: 가장 긴 latin/기술 토큰(LangGraph, React, PDF 등) — 가장 강한 주제 신호.
 *  - 2순위: 길이 3 이상의 한국어 핵심어(크롤링, 채용공고, 리포트 등) — latin 이 없는 경험(예: 크롤링)을 잡기 위함.
 *  - 둘 다 없으면(짧은 부연 설명 줄) null → 주제로 만들지 않는다.
 */
function dominantAnchor(keywords: Keyword[]): Keyword | null {
  const latin = keywords
    // 20자 초과 latin 은 PDF 에서 공백이 뭉개진 이름+직함 헤더("KIMHEESEOFull-stackDeveloper")일
    // 가능성이 높다. 정상 기술 토큰(React·PostgreSQL 등)은 이보다 짧으므로 앵커에서 제외.
    .filter((k) => k.kind === "latin" && k.text.length <= 20)
    .sort((a, b) => b.text.length - a.text.length);
  if (latin.length) return latin[0];
  const korean = keywords
    .filter((k) => k.kind === "korean" && k.text.length >= 3)
    .sort((a, b) => b.text.length - a.text.length);
  return korean[0] ?? null;
}

/** 앵커로부터 안정적인 주제 키를 만든다. latin 은 소문자 원형, 한국어는 "t-" 접두. */
function canonicalKey(anchor: Keyword): string {
  return anchor.kind === "latin" ? anchor.text.toLowerCase() : `t-${anchor.text}`;
}

/** 주제 라벨 = 해당 경험 문장의 짧은 발췌(실제 resumeText 문장이라 grounding 안전). */
function topicLabel(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 48).trim()}…` : trimmed;
}

/**
 * resumeText 에서 주제 카탈로그를 추출한다(결정적 — 같은 입력이면 항상 같은 결과).
 *  - 같은 앵커를 가진 줄들은 하나의 주제로 합친다(시그니처 키워드는 합집합, 라벨은 더 짧은 문장).
 *  - 주제가 2개 미만이면 전체 텍스트로 다시 시도한다(역량/자기소개에서라도 앵커를 줍는다).
 */
export function extractResumeTopics(resumeText: string): ResumeTopic[] {
  const clean = stripUrls(resumeText); // URL/링크는 주제 앵커가 되지 않도록 미리 제거
  const build = (text: string): ResumeTopic[] => {
    const lines = splitUnits(text)
      .map(cleanLine)
      .filter((l) => l.length >= 6 && !SECTION_HEADER.test(l));

    const byKey = new Map<string, ResumeTopic>();
    for (const line of lines) {
      const kws = extractKeywords(line);
      const anchor = dominantAnchor(kws);
      if (!anchor) continue;
      const key = canonicalKey(anchor);
      const sig = kws.map((k) => k.text.toLowerCase());
      const existing = byKey.get(key);
      if (existing) {
        for (const s of sig) if (!existing.keywords.includes(s)) existing.keywords.push(s);
        if (line.length < existing.label.length) existing.label = topicLabel(line);
      } else {
        byKey.set(key, { key, label: topicLabel(line), keywords: sig });
      }
    }
    return [...byKey.values()];
  };

  let topics = build(projectSection(clean));
  if (topics.length < 2) topics = build(clean);
  return topics;
}

/**
 * 생성된 질문(question + basis)이 어느 주제에 속하는지 판정한다.
 *  - 주제별 시그니처 키워드와의 겹침 점수를 매긴다(latin/숫자는 가중치 3, 한국어는 1).
 *  - 가장 높은 주제를 고르고, 어떤 주제와도 겹치지 않으면(점수 0) 질문 자체의 앵커로 합성 키를 만든다.
 *    → 합성 키도 같은 앵커면 같은 값이 나오므로 "표현만 바꾼 유사 질문"이 같은 주제로 누적된다.
 */
export function classifyQuestionTopic(
  question: string,
  basis: string,
  topics: ResumeTopic[]
): string {
  const kws = extractKeywords(stripUrls(`${question} ${basis}`));
  let best: ResumeTopic | null = null;
  let bestScore = 0;
  for (const t of topics) {
    let score = 0;
    for (const k of kws) {
      if (t.keywords.includes(k.text.toLowerCase())) {
        score += k.kind === "latin" || k.kind === "numeric" ? 3 : 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (best && bestScore > 0) return best.key;

  // 카탈로그와 겹치지 않는 질문: 질문 자체의 앵커로 합성 키를 만든다(없으면 misc).
  const anchor = dominantAnchor(kws);
  return anchor ? canonicalKey(anchor) : "t-misc";
}

/** topicCounts 기준 아직 한 번도 묻지 않은(count 0) 주제들. 새 주제 우선 선택에 쓴다. */
export function unusedTopics(
  topics: ResumeTopic[],
  counts: Record<string, number>
): ResumeTopic[] {
  return topics.filter((t) => (counts[t.key] ?? 0) === 0);
}

/** topicCounts 기준 소진된(count >= 2) 주제들. 다음 메인 질문에서 제외한다. */
export function exhaustedTopics(
  topics: ResumeTopic[],
  counts: Record<string, number>
): ResumeTopic[] {
  return topics.filter((t) => (counts[t.key] ?? 0) >= 2);
}
