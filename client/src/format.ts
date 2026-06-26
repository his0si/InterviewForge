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
