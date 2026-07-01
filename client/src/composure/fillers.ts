// 채움말(filler)·회피 표현 감지 — 자막(STT 텍스트)에서 계산한다.
//  - 채움말: "음/어/그/저기/약간/이제/그니까…" 같은 말버릇. 압박 상황에서 늘어난다.
//  - 회피/불확실: "잘 모르겠어요/글쎄요/기억이 안…" 같은 표현. 답변 충실도(engagement)에 반영.

// 경계(공백/문장부호/문자열끝)로 감싸인 채움말만 센다. 일반 단어 오탐을 줄인다.
const FILLER_WORDS = [
  "음+",
  "으음+",
  "어+", // "어" 늘임(어…)
  "에+",
  "그니까",
  "그러니까",
  "뭐랄까",
  "뭔가",
  "약간",
  "이제",
  "인제",
  "저기",
  "그쵸",
  "말하자면",
  "이렇게",
  "그렇게",
];

const HEDGES = [
  "잘 모르겠",
  "잘모르겠",
  "글쎄",
  "기억이 안",
  "기억이안",
  "기억은 안",
  "정확히는",
  "정확하게는",
  "아마도",
  "딱히",
  "특별히",
  "잘 기억",
  "확실하진",
  "확실하지",
];

const FILLER_RE = new RegExp(
  "(^|[\\s,.!?…·]|\\b)(" + FILLER_WORDS.join("|") + ")(?=$|[\\s,.!?…·]|\\b)",
  "gu"
);

/** 텍스트의 채움말 개수. */
export function countFillers(text: string): number {
  if (!text) return 0;
  const m = text.match(FILLER_RE);
  return m ? m.length : 0;
}

/** 회피/불확실 표현 개수. */
export function countHedges(text: string): number {
  if (!text) return 0;
  const t = text.toLowerCase();
  let n = 0;
  for (const h of HEDGES) {
    let i = t.indexOf(h);
    while (i !== -1) {
      n++;
      i = t.indexOf(h, i + h.length);
    }
  }
  return n;
}

/** 공백 제거한 실질 글자 수(발화량/속도 계산용). */
export function contentChars(text: string): number {
  return (text ?? "").replace(/\s+/g, "").length;
}
