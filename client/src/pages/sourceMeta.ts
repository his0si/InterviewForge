// 출처별 한글 라벨 + 칩 색상. 목록/상세 공용.
export const SOURCE_META: Record<string, { label: string; color: string }> = {
  saramin: { label: "사람인", color: "#1f64ff" },
  wanted: { label: "원티드", color: "#3366ff" },
  rocketpunch: { label: "로켓펀치", color: "#e8344e" },
  jasoseol: { label: "자소설닷컴", color: "#7c4dff" },
  linkareer: { label: "링커리어", color: "#00b894" },
  jobkorea: { label: "잡코리아", color: "#1e90ff" },
  incruit: { label: "인크루트", color: "#ff6f00" },
  peoplenjob: { label: "피플앤잡", color: "#2d6a4f" },
  superookie: { label: "슈퍼루키", color: "#ff4081" },
  jobplanet: { label: "잡플래닛", color: "#00c4b3" },
  groupby: { label: "그룹바이", color: "#5769f3" },
};

export const sourceMeta = (s: string) =>
  SOURCE_META[s] ?? { label: s, color: "#6b7280" };

// 직무(개발자/디자이너 등) 표시값: 숫자 코드가 아닌 첫 직무 분류를 사용.
export const jobRole = (jobCategories: string[]): string | null =>
  jobCategories.find((c) => c && !/^\d+$/.test(c)) ?? null;
