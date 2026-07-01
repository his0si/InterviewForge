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

// \uC774\uB825\uC11C \uC0C1\uB2E8\uC758 \uAC1C\uC778\uC815\uBCF4/\uC5F0\uB77D\uCC98\uB97C \uC81C\uAC70\uD55C\uB2E4.
// \uBA74\uC811 \uC9C8\uBB38\uC740 "\uACBD\uD5D8"\uC744 \uADFC\uAC70\uB85C \uC0BC\uC544\uC57C \uD558\uB294\uB370, \uC5F0\uB77D\uCC98 \uBE14\uB85D(\uC774\uBA54\uC77C\u00B7\uC804\uD654\u00B7GitHub \uB4F1)\uC774
// resumeText \uC5D0 \uC11E\uC5EC \uC788\uC73C\uBA74 LLM/\uC8FC\uC81C\uCD94\uCD9C\uAE30\uAC00 \uADF8\uAC78 "\uACBD\uD5D8"\uC73C\uB85C \uC624\uC778\uD574
// "\uC774\uB825\uC11C\uC5D0 \uC801\uD78C 'Contact Phone 010-\u2026 Email \u2026' \uACBD\uD5D8\uC5D0\uC11C\u2026" \uAC19\uC740 \uC774\uC0C1\uD55C \uC9C8\uBB38\uC744 \uB9CC\uB4E0\uB2E4.
// \u2192 \uC9C8\uBB38 \uADFC\uAC70\uB85C \uC4F0\uAE30 \uC804\uC5D0 \uC5F0\uB77D\uCC98\uC131 \uD1A0\uD070\uC744 \uAC77\uC5B4\uB0B8\uB2E4(\uC774\uBA54\uC77C\u00B7\uC804\uD654\u00B7\uC5F0\uB77D\uCC98 \uB77C\uBCA8).
export function stripContactInfo(text: string): string {
  return (
    text
      // \uC774\uBA54\uC77C
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ")
      // \uC804\uD654\uBC88\uD638: \uD734\uB300\uD3F0(+\uAD6D\uC81C \uC811\uB450), \uC720\uC120(\uAD6C\uBD84\uC790 \uD544\uC218 \u2192 \uC131\uACFC \uC218\uCE58 \uC624\uC778 \uBC29\uC9C0)
      .replace(/(?:\+?\d{1,3}[)\-.\s]?)?01[016789][)\-.\s]?\d{3,4}[)\-.\s]?\d{4}/g, " ")
      .replace(/\b0\d{1,2}[)\-.\s]\d{3,4}[)\-.\s]\d{4}\b/g, " ")
      // \uC5F0\uB77D\uCC98/\uB9C1\uD06C \uB77C\uBCA8(\uAC12\uC740 \uC704\uC5D0\uC11C \uC774\uBBF8 \uC81C\uAC70\uB428) \u2014 \uB77C\uBCA8 \uB2E8\uC5B4\uB9CC \uC815\uB9AC
      .replace(
        /\b(?:Contact|Phone|Tel|Mobile|H\.?P\.?|E-?mail|GitHub|Git|Blog|Portfolio|LinkedIn|Notion|Website|Homepage)\b\s*[:\uFF1A]?/gi,
        " "
      )
      .replace(/(?:\uC5F0\uB77D\uCC98|\uC804\uD654\uBC88\uD638|\uC804\uD654|\uD734\uB300\uD3F0|\uC774\uBA54\uC77C|\uBA54\uC77C\uC8FC\uC18C|\uC8FC\uC18C|\uAE43\uD5C8\uBE0C|\uBE14\uB85C\uADF8|\uD3EC\uD2B8\uD3F4\uB9AC\uC624|\uD648\uD398\uC774\uC9C0)\s*[:\uFF1A]?/g, " ")
      // \uB0A8\uC740 \uACFC\uB3C4\uD55C \uACF5\uBC31 \uC815\uB9AC
      .replace(/[ \t]{2,}/g, " ")
  );
}
