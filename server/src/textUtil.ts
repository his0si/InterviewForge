// 텍스트 정리 유틸(이력서 원문 추출·분석 공용).

// 자간 벌림(letter-spacing) 정리.
// 디자인된 이력서 헤더는 "K I M  f u l l - s t a c k" 처럼 글자 사이에 공백이 들어가 추출된다.
// ASCII 단일 문자가 공백(일반/비분리)으로 이어진 3글자 이상 구간을 한 덩어리로 합친다.
// (한글 구절을 오인해 붙이지 않도록 ASCII 구간만 대상으로 한다.)
const SPACES = "[ \\u00A0]"; // 일반 공백 + 비분리 공백(U+00A0)
const LETTER_SPACED = new RegExp(`(?:[\\x21-\\x7E]${SPACES}){2,}[\\x21-\\x7E]`, "g");

export function collapseLetterSpacing(text: string): string {
  return text.replace(LETTER_SPACED, (m) => m.replace(/[ \u00A0]/g, ""));
}
