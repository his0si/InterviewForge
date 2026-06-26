// 이력서 원문(extracted_text) → 로컬 LLM 2-pass 분석.
//  1) 구조화 추출: skills/roles/experiences 등 프로필 JSON (면접 질문·공고 추천에서 재사용)
//     - 경력 연수(years)는 모델이 추측하지 않고, 추출된 experiences(정규직·계약직 기간)로 코드가 계산한다.
//  2) 마크다운 피드백: 강점/보완점/예상 면접 약점
// 로컬 모델은 한 건당 수십 초가 걸리므로 업로드와 분리해 백그라운드로 실행한다.
import type { ResumeProfile } from "@e-lifethon/shared";
import { pool } from "./db.js";
import { generate, generateJson } from "./ollama.js";
import { collapseLetterSpacing } from "./textUtil.js";

const MAX_CHARS = 6000; // 컨텍스트 보호: 너무 긴 이력서는 앞부분 위주로 사용

const PROFILE_PROMPT = `너는 채용 전문가다. 아래 '이력서 원문'만 근거로 핵심 정보를 추출해 JSON 으로만 답하라.
규칙: 원문에 있는 사실만 사용(추측·창작 금지). 해당 정보가 없으면 배열은 [] 로 둔다.
"빈 배열" 같은 안내 문구를 값으로 넣지 말 것(반드시 실제 데이터 또는 []).
키:
- summary: 지원자를 한 문장으로 요약(문자열)
- roles: 어울리는 직무 배열(예: ["백엔드 개발자"])
- skills: 보유 기술/역량 배열(예: ["Java","Spring","SQL"])
- experiences: 이력서에서 "기간(시작~종료)이 적힌 모든 활동"을 객체 배열로 추출한다.
  각 객체 형식: {"type":"...", "start":"YYYY-MM", "end":"YYYY-MM"}
  - type 은 활동의 성격을 다음 중 하나로 정확히 분류: "정규직", "계약직", "인턴", "프로젝트", "동아리", "공모전", "교육", "기타"
    · 회사에 고용되어 일한 것만 "정규직"/"계약직" 으로 적는다.
    · 동아리·학회·운영진·TF, 개인/팀 프로젝트, 공모전, 부트캠프·강의 수강, 재학/졸업, 인턴은 절대 "정규직"/"계약직" 으로 적지 말 것(각각 알맞은 type 사용).
  - start/end 는 "YYYY-MM" 형식. 진행 중이면 end 를 "현재" 로. 날짜를 알 수 없는 항목은 배열에 넣지 말 것.
  (경력 연수는 이 목록을 보고 시스템이 직접 계산하므로 너는 분류와 기간만 정확히 적으면 된다.)
- domains: 경험한 산업/도메인 배열(예: ["핀테크"])
- strengths: 강점 배열(짧은 구)
- weaknesses: 보완하면 좋을 점 배열(짧은 구)
- keywords: 검색/매칭용 핵심 키워드 배열

이력서 원문:
---
{body}`;

const FEEDBACK_PROMPT = `너는 면접 코치다. 아래 이력서를 읽고 한국어 마크다운으로 피드백을 작성하라.
추측·창작 금지(원문 근거). 과하게 길지 않게, 실질적인 조언 위주로.

출력 형식(이 형식만):
**한 줄 총평**: (1문장)
**강점**:
- (불릿)
**보완하면 좋을 점**:
- (불릿)
**예상 면접 약점/주의**:
- (불릿)

이력서 원문:
---
{body}`;

// 모델이 가끔 값 대신 넣는 안내 문구를 걸러낸다.
const JUNK = new Set(["빈 배열", "없음", "해당 없음", "정보 없음", "n/a", "na", "null", "none", "-"]);

function clampStrArr(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => String(x).trim())
    .filter((s) => s && !JUNK.has(s.toLowerCase()))
    .slice(0, max);
}

// 실무 경력으로 인정하는 고용 형태. 인턴·동아리·프로젝트·공모전·교육·재학 등은 제외한다.
const PAID_EMPLOYMENT = new Set(["정규직", "계약직"]);

// "2024-03", "2024.3", "2024년 3월", "2024" 등을 월 단위 정수(YYYY*12+MM)로 변환. 실패 시 null.
function parseYearMonth(raw: unknown): number | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/현재|재직|진행|present|now|current/i.test(s)) {
    const d = new Date();
    return d.getFullYear() * 12 + (d.getMonth() + 1);
  }
  const m = s.match(/(\d{4})\D*(\d{1,2})?/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > 2100) return null;
  const mo = m[2] ? Math.min(12, Math.max(1, Number(m[2]))) : 1;
  return y * 12 + mo;
}

// experiences 목록에서 정규직·계약직 기간만 합산해 경력 연수를 계산한다.
// 겹치는 구간은 한 번만 센다. 날짜 있는 항목이 하나도 없으면 '판단 불가'(null), 있지만 고용 경력이 없으면 0년.
function computeYears(experiences: unknown): number | null {
  if (!Array.isArray(experiences) || experiences.length === 0) return null;
  const intervals: Array<[number, number]> = [];
  for (const e of experiences as Array<any>) {
    const type = String(e?.type ?? "").trim();
    if (!PAID_EMPLOYMENT.has(type)) continue;
    const start = parseYearMonth(e?.start);
    const end = parseYearMonth(e?.end);
    if (start == null || end == null || end < start) continue;
    intervals.push([start, end]);
  }
  if (intervals.length === 0) return 0; // 이력은 있으나 인정되는 고용 경력은 없음
  intervals.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [curStart, curEnd] = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s <= curEnd) curEnd = Math.max(curEnd, e);
    else {
      months += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  months += curEnd - curStart;
  return Math.round((months / 12) * 10) / 10; // 소수 1자리 연 단위
}

function normalizeProfile(raw: any): ResumeProfile {
  return {
    summary: String(raw?.summary ?? "").trim(),
    roles: clampStrArr(raw?.roles),
    skills: clampStrArr(raw?.skills, 40),
    years: computeYears(raw?.experiences),
    domains: clampStrArr(raw?.domains),
    strengths: clampStrArr(raw?.strengths),
    weaknesses: clampStrArr(raw?.weaknesses),
    keywords: clampStrArr(raw?.keywords, 40),
  };
}

// 이력서 한 건을 분석하고 결과를 DB 에 반영한다. (백그라운드 호출 가정 — 예외를 삼키고 status 만 갱신)
export async function analyzeResume(id: number): Promise<void> {
  try {
    const r = await pool.query(`SELECT extracted_text FROM resumes WHERE id = $1`, [id]);
    if (r.rowCount === 0) return;
    // 자간 벌림 등 추출 노이즈 정리(이미 저장된 옛 원문도 재분석 시 함께 보정).
    const text = collapseLetterSpacing(String(r.rows[0].extracted_text ?? "").trim());
    if (text.length < 30) {
      await pool.query(
        `UPDATE resumes SET analysis_status = 'error', analyzed_at = now() WHERE id = $1`,
        [id]
      );
      return;
    }

    await pool.query(`UPDATE resumes SET analysis_status = 'processing' WHERE id = $1`, [id]);

    const body = text.slice(0, MAX_CHARS);
    const rawProfile = await generateJson<any>(PROFILE_PROMPT.replace("{body}", body));
    const profile = normalizeProfile(rawProfile);
    const feedback = await generate(FEEDBACK_PROMPT.replace("{body}", body), { temperature: 0.2 });

    await pool.query(
      `UPDATE resumes
         SET analysis = $1, feedback = $2, analysis_status = 'done', analyzed_at = now()
       WHERE id = $3`,
      [JSON.stringify(profile), feedback || null, id]
    );
  } catch (err) {
    await pool
      .query(`UPDATE resumes SET analysis_status = 'error', analyzed_at = now() WHERE id = $1`, [id])
      .catch(() => {});
    throw err;
  }
}

// 부팅 시 보정: 아직 분석되지 않은(원문은 있는) 이력서를 순차 분석한다.
// 예) 분석 기능 배포 전 업로드되어 'pending' 으로 남은 이력서를 자동 처리.
export async function analyzePendingResumes(): Promise<void> {
  try {
    // 원문이 없어 분석 불가한 'pending' 은 즉시 error 로 정리(진행바가 영원히 도는 것 방지).
    await pool.query(
      `UPDATE resumes SET analysis_status = 'error', analyzed_at = now()
        WHERE analysis_status IN ('pending', 'processing')
          AND (extracted_text IS NULL OR char_length(extracted_text) < 30)`
    );
    const r = await pool.query(
      `SELECT id FROM resumes
        WHERE analysis_status IN ('pending', 'processing')
          AND extracted_text IS NOT NULL AND char_length(extracted_text) >= 30
        ORDER BY id ASC`
    );
    for (const row of r.rows) {
      await analyzeResume(row.id as number).catch(() => {}); // 한 건 실패해도 계속
    }
  } catch {
    /* 부팅 보정 실패는 조용히 무시(서비스에 영향 없음) */
  }
}
