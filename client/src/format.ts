// 공통 포맷 유틸.

// 채용 공고 마감일을 사람이 읽기 좋은 형태로 변환한다.
// deadline 은 "2026-07-10T00:00:00.000Z" 같은 ISO 문자열(날짜만 유효)이라
// 타임존 변환 없이 날짜 부분만 잘라 "2026.07.10" 로 보여준다.
export function formatDeadline(deadline: string | null): string {
  if (!deadline) return "";
  const datePart = deadline.slice(0, 10); // YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return deadline;
  return datePart.replace(/-/g, ".");
}

// STT 자막/답변을 읽기 좋은 문장(단락) 배열로 정리한다.
//  - 실시간 STT 는 interim→final 이 겹쳐 같은 문장이 두 번 나오거나(중복), 앞부분이 늘어나며
//    재출력되는(접두 중복) 경우가 많다. 이를 정리해 한 문장 = 한 줄로 만든다.
export function formatSpeech(text: string): string[] {
  if (!text) return [];
  const lines = text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (prev) {
      if (prev === line) continue; // 완전 동일 → 스킵
      if (line.startsWith(prev)) {
        out[out.length - 1] = line; // 늘어난 재출력 → 더 긴 문장으로 교체
        continue;
      }
      if (prev.startsWith(line)) continue; // 앞부분만 재출력 → 스킵
    }
    out.push(line);
  }
  return out;
}
