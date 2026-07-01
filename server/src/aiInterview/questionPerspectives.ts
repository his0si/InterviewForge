// 질문 "관점(perspective)" 카탈로그 — 같은 "질문 주제(관점)"를 반복하지 않도록 코드 레벨에서 관리한다.
//
// 배경(요구사항 #2):
//  - resumeTopics 가 막는 것은 "같은 프로젝트/경험"을 반복해서 묻는 것(=이력서 주제 반복)이다.
//  - 그러나 서로 다른 경험을 묻더라도 "묻는 관점"이 늘 같으면(예: 매번 '기술을 선택한 이유') 면접이 단조로워진다.
//    · "PDF 추출 기능에서 해당 기술을 선택한 이유는?"
//    · "LangGraph를 선택한 이유는?"
//    · "React를 선택한 이유는?"
//    → 이력서 주제는 다르지만 모두 "기술 선택 및 판단 이유"라는 같은 관점이다.
//  - 그래서 이력서 주제 제한(최대 2회)과 별개로, "질문 관점"도 전체 메인 질문에서 최대 2회까지만 허용한다.
//    세 번째부터는 다른 관점(구현 방식·문제 해결·역할·성과 등)으로 질문하도록 강제한다.
//
// 설계:
//  - 형태소 분석기/외부 의존성 없이, 관점마다 "신호 표현(부분 문자열)" 집합을 두고 질문 텍스트와 겹침을 본다.
//  - resumeTopics 의 키워드 추출은 "명사 앵커"를 잡는 데 특화돼 있어 "선택한 이유/어떻게 설계" 같은
//    관점 신호(동사·연결 표현)를 놓치므로, 여기서는 원문 부분 문자열 매칭을 직접 쓴다.
//  - classifyQuestionPerspective 는 같은 입력이면 항상 같은 키를 돌려준다(결정적).

/** 하나의 "질문 관점"(묻는 각도). */
export interface QuestionPerspective {
  /** 코드에서 관점을 식별하는 안정적인 키. */
  key: string;
  /** 사람이 읽는 라벨(프롬프트의 제외 목록에 그대로 노출). */
  label: string;
  /** 이 관점을 가리키는 신호 표현(질문·basis 안에 부분 문자열로 들어 있으면 매칭). */
  signals: string[];
}

/** 같은 질문 관점을 메인 질문에서 최대 몇 번까지 허용할지(이력서 주제 제한과 같은 2). */
export const PERSPECTIVE_LIMIT = 2;

/**
 * 관점 카탈로그(고정). 위에서부터 우선순위가 높다(동점 시 먼저 선언된 관점으로 분류).
 *  - 가장 구별이 뚜렷한 "기술 선택 이유"를 맨 위에 두어, 요구사항의 핵심 사례를 확실히 잡는다.
 */
const PERSPECTIVES: QuestionPerspective[] = [
  {
    key: "tech-choice",
    label: "기술 선택 및 판단 이유",
    signals: [
      "선택한 이유", "선택 이유", "선택하신", "선택했", "선택한", "왜 선택", "택한 이유",
      "채택", "고른 이유", "고르신", "도입한 이유", "결정한 이유", "선정", "쓴 이유", "사용한 이유",
      "대신", "비교해", "장단점", "트레이드오프", "trade-off", "tradeoff",
    ],
  },
  {
    key: "design-impl",
    label: "구현 방식·설계 의도",
    signals: [
      "설계", "구현", "구조", "아키텍처", "어떻게 만", "어떻게 구", "방식", "동작 흐름",
      "처리 흐름", "흐름을", "로직", "구성했", "어떻게 나누", "상태 전이", "데이터 흐름",
    ],
  },
  {
    key: "role",
    label: "본인의 역할·기여",
    signals: [
      "역할", "맡은", "맡으신", "담당", "기여", "직접 한", "직접 맡", "본인이 한", "본인의",
      "분담", "어느 부분을", "어떤 일을",
    ],
  },
  {
    key: "problem-solving",
    label: "문제 해결 과정",
    signals: [
      "문제", "어려", "해결", "트러블", "이슈", "장애", "버그", "디버", "극복", "한계",
      "병목", "실패", "시행착오", "막혔",
    ],
  },
  {
    key: "result",
    label: "성과·결과",
    signals: [
      "성과", "결과", "개선", "효과", "지표", "성능", "수치", "정량", "측정", "얼마나",
      "전후", "기여도", "임팩트",
    ],
  },
  {
    key: "collaboration",
    label: "협업·소통",
    signals: [
      "협업", "소통", "갈등", "커뮤니", "코드 리뷰", "리뷰", "팀원", "동료", "조율",
      "설득", "의견 차이",
    ],
  },
  {
    key: "retrospective",
    label: "학습·회고",
    signals: [
      "배운", "배우신", "회고", "아쉬", "다시 한다면", "다시 돌아간다면", "교훈",
      "성장", "개선점", "다음에", "보완하고 싶",
    ],
  },
];

/**
 * 어느 관점에도 또렷이 속하지 않는 질문을 담는 기본 관점.
 *  - 이 관점은 "분류 안 되는 잡다한 질문"의 바구니이므로 횟수 제한을 두지 않는다(무제한).
 *  - 따라서 exhaustedPerspectives 의 소진 판정 대상에서 제외한다(7개 구체 관점만 최대 2회로 제한).
 */
export const GENERAL_PERSPECTIVE: QuestionPerspective = {
  key: "general",
  label: "특정 관점이 뚜렷하지 않은 일반 질문",
  signals: [],
};

/** key 로 관점을 찾는다(없으면 일반 관점). */
export function perspectiveByKey(key: string): QuestionPerspective {
  return PERSPECTIVES.find((p) => p.key === key) ?? GENERAL_PERSPECTIVE;
}

/**
 * 질문(question + basis)이 어느 "관점"에 속하는지 결정적으로 판정한다.
 *  - 관점별 신호 표현이 질문 텍스트에 몇 개나 들어 있는지 센다.
 *  - 가장 많이 겹치는 관점을 고르고, 어디에도 겹치지 않으면 일반 관점으로 본다.
 *  - 동점이면 카탈로그 선언 순서가 빠른(=구별이 뚜렷한) 관점을 택한다.
 */
export function classifyQuestionPerspective(question: string, basis: string): string {
  const text = `${question} ${basis}`;
  let bestKey = GENERAL_PERSPECTIVE.key;
  let bestScore = 0;
  for (const p of PERSPECTIVES) {
    let score = 0;
    for (const s of p.signals) if (text.includes(s)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestKey = p.key;
    }
  }
  return bestKey;
}

/**
 * counts 기준 소진된(>= PERSPECTIVE_LIMIT) 관점들. 다음 메인 질문에서 제외한다.
 *  - 일반 관점(general)은 제한 대상이 아니므로 아무리 많이 나와도 여기 포함하지 않는다(무제한).
 */
export function exhaustedPerspectives(counts: Record<string, number>): QuestionPerspective[] {
  return PERSPECTIVES.filter((p) => (counts[p.key] ?? 0) >= PERSPECTIVE_LIMIT);
}

/** counts 기준 아직 소진되지 않은(< PERSPECTIVE_LIMIT) "구체" 관점들(일반 관점은 권장 대상에서 제외). */
export function availablePerspectives(counts: Record<string, number>): QuestionPerspective[] {
  return PERSPECTIVES.filter((p) => (counts[p.key] ?? 0) < PERSPECTIVE_LIMIT);
}
