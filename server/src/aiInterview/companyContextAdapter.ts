// 회사·직무 선택 → 회사 DB(SELECT only) 참고자료 → startInterview 용 context/anchor 생성.
//
// 설계 원칙(중요):
//  - 기존 LangGraph/질문 생성/평가/꼬리질문/리포트 로직은 건드리지 않는다.
//  - 이 파일은 "면접 시작 전에 context 문자열·첫 질문 앵커를 만들어 주는 어댑터"일 뿐이다.
//  - 회사 자료가 없거나 직무와 매칭되는 기사가 없으면 context=undefined / anchor=undefined 를 돌려주어
//    기존 resumeText 기반 면접이 그대로 진행되게 한다(fallback).
//
// DB 접근(읽기 전용):
//  - company_contexts 단일 테이블을 company_key 파라미터($1)로만 SELECT 한다(테이블명 조합·문자열 보간 없음 → 인젝션 불가).
//  - 앱 공용 pg pool(../db.js)에서 커넥션 1개를 빌려 read-only 트랜잭션 + statement_timeout 으로 감싼다.
//  - 실패해도 면접 전체를 실패시키지 않고 context 없이 진행한다. DB 오류 stack 은 출력하지 않는다.

import { pool } from "../db.js";
import { resolveCompany } from "./companyRegistry.js";
import type { CompanyAnchor } from "./types.js";

// content_type → 사용자 표시명(질문 근거에 사람이 읽기 쉬운 항목명 표시).
const CONTENT_TYPE_LABELS: Record<string, string> = {
  work_culture: "공식 일하는 방식(Work Culture)",
  talent_profile: "공식 인재상",
  official_article: "공식 직무 기사",
  external_news: "외부 언론 기사",
};

// ─────────────────────────────────────────────────────────────────────────────
// 결과 타입 — context 문자열 + 진단용 메타.
// ─────────────────────────────────────────────────────────────────────────────
export interface CompanyContextResult {
  /** startInterview 에 넘길 context. 없으면 undefined → resumeText 기반 면접. */
  context?: string;
  /** 회사 식별 성공 여부(레지스트리/slug 로 company_key 가 정해짐). */
  companyMatched: boolean;
  /** 식별된 회사 표시명. */
  displayName?: string;
  /** 식별된 company_key. */
  companyKey?: string;
  /** 입력한 직무(trim). */
  selectedRole: string;
  /** DB 접속/조회 결과. 회사 미식별이라 조회를 시도하지 않았으면 undefined. */
  dbConnected?: boolean;
  /** 선택된 회사 문화(최대 2개). */
  workCulture: { key: string; name: string }[];
  /** 선택된 직무 기사(직무와 매칭된 1개). */
  officialArticle?: { roleName: string; sourceUrl: string };
  /** 선택된 최근 이슈(직무와 직접 연결될 때만 1개). */
  externalNews?: { title: string; publishedAt: string | null };
  /** 첫 메인 질문을 회사 DB 자료에 근거시키는 앵커(없으면 resume-only). */
  companyAnchor?: CompanyAnchor;
  /** 회사는 식별됐고 DB 연결도 됐으나 수집 데이터가 0건 → JIT 수집 요청 대상. */
  dataMissing?: boolean;
  /** 사용자에게 보여줄 한 줄 안내(있을 때만). */
  notice?: string;
}

const FALLBACK_NOTICE = "회사 참고자료를 불러오지 못해 이력서 기반 면접으로 진행합니다.";
const UNREGISTERED_NOTICE = "해당 회사 참고자료 없음";

// ─────────────────────────────────────────────────────────────────────────────
// 고정 SQL(SELECT only). company_key 로만 필터. source_text 원문은 조회하지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
const FIXED_SELECT_SQL = `
  SELECT id, content_type, title, source_name, source_url, published_at, extracted_data
  FROM public.company_contexts
  WHERE company_key = $1
    AND content_type IN ('work_culture', 'official_article', 'external_news')
  ORDER BY published_at DESC NULLS LAST, id DESC
`;

interface DbRow {
  id: number;
  content_type: string;
  title: string;
  source_name: string;
  source_url: string;
  published_at: Date | string | null;
  extracted_data: any;
}

/** 회사 참고자료를 읽는다(읽기 전용). 실패하면 throw → 호출부에서 잡아 context 없이 진행. */
async function fetchCompanyRows(companyKey: string): Promise<DbRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    const res = await client.query(FIXED_SELECT_SQL, [companyKey]);
    await client.query("COMMIT");
    return res.rows as DbRow[];
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* rollback 실패는 무시 */
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// extracted_data 파싱 — 수집 파이프라인 출력 구조 해석.
// ─────────────────────────────────────────────────────────────────────────────
interface Culture {
  key: string;
  name: string;
  description: string;
  behaviors: string[];
}
interface Article {
  roleName: string;
  aliases: string[];
  overview: string;
  mainTasks: string[];
  subAreas: string[];
  requiredKnowledge: string[];
  competencies: string[];
  sourceUrl: string;
}
interface News {
  title: string;
  publishedAt: string | null;
  summary: string;
  keyFacts: string[];
  sourceName: string;
  sourceUrl: string;
}

function toDateString(v: Date | string | null): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function extractCultures(row: DbRow): Culture[] {
  const values = (row.extracted_data?.values ?? []) as any[];
  return values.map((v) => ({
    key: v.key ?? "",
    name: v.nameKo || v.originalTitle || v.key || "",
    description: v.description ?? "",
    behaviors: Array.isArray(v.behaviors) ? v.behaviors : [],
  }));
}

function extractArticle(row: DbRow): Article {
  const jr = row.extracted_data?.jobRole ?? {};
  const comps = (row.extracted_data?.competencies ?? []) as any[];
  return {
    roleName: jr.name || row.title || "",
    aliases: Array.isArray(jr.aliases) ? jr.aliases : [],
    overview: jr.overview ?? "",
    mainTasks: Array.isArray(jr.mainTasks) ? jr.mainTasks : [],
    subAreas: Array.isArray(jr.subAreas) ? jr.subAreas : [],
    requiredKnowledge: Array.isArray(jr.requiredKnowledge) ? jr.requiredKnowledge : [],
    competencies: comps.map((c) => c?.name).filter((n): n is string => !!n),
    sourceUrl: row.source_url ?? "",
  };
}

function extractNews(row: DbRow): News {
  const ev = row.extracted_data?.event ?? {};
  return {
    title: row.title ?? "",
    publishedAt: toDateString(row.published_at),
    summary: row.extracted_data?.articleSummaryKo || ev.eventTitle || "",
    keyFacts: Array.isArray(ev.keyFacts) ? ev.keyFacts : [],
    sourceName: row.source_name ?? "",
    sourceUrl: row.source_url ?? "",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 선택 로직 — 직무 기사(게이트) / 회사 문화(≤2) / 최근 이슈(≤1).
// ─────────────────────────────────────────────────────────────────────────────
function normalize(s: string): string {
  return (s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenize(...parts: (string | string[] | undefined)[]): string[] {
  const text = parts.flatMap((p) => (Array.isArray(p) ? p : [p ?? ""])).join(" ");
  const raw = text
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  return Array.from(new Set(raw));
}

function keywordHits(text: string, keywords: string[]): number {
  const lower = (text ?? "").toLowerCase();
  let n = 0;
  for (const k of keywords) if (k && lower.includes(k)) n++;
  return n;
}

function pickRoleArticle(articles: Article[], selectedRole: string): Article | undefined {
  const role = normalize(selectedRole);
  if (!role) return undefined;
  type Scored = { article: Article; score: number; nameLen: number };
  const scored: Scored[] = [];
  for (const a of articles) {
    const names = [a.roleName, ...a.aliases].map(normalize).filter(Boolean);
    let best = 0;
    for (const nm of names) {
      if (nm === role) best = Math.max(best, 3);
      else if (nm.includes(role)) best = Math.max(best, 2);
      else if (role.includes(nm)) best = Math.max(best, 1);
    }
    if (best > 0) scored.push({ article: a, score: best, nameLen: normalize(a.roleName).length });
  }
  if (scored.length === 0) return undefined;
  scored.sort((x, y) => y.score - x.score || x.nameLen - y.nameLen);
  return scored[0].article;
}

function pickCultures(cultures: Culture[], keywords: string[]): Culture[] {
  const scored = cultures.map((c, i) => ({
    culture: c,
    score: keywordHits([c.name, c.description, c.behaviors.join(" ")].join(" "), keywords),
    order: i,
  }));
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, 2).map((s) => s.culture);
}

const NEWS_EXCLUDE_KEYWORDS = ["목표주가", "주가", "주식", "정치", "부동산", "공방"];

function pickNews(newsList: News[], roleKeywords: string[]): News | undefined {
  const scored = newsList
    .filter((n) => !NEWS_EXCLUDE_KEYWORDS.some((k) => (n.title ?? "").toLowerCase().includes(k)))
    .map((n) => ({
      news: n,
      score: keywordHits([n.title, n.summary, n.keyFacts.join(" ")].join(" "), roleKeywords),
    }))
    .filter((s) => s.score >= 1);
  if (scored.length === 0) return undefined;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].news;
}

// ─────────────────────────────────────────────────────────────────────────────
// context 문자열 렌더링. 자료 없는 섹션은 생략.
// ─────────────────────────────────────────────────────────────────────────────
const CONTEXT_RULES = [
  "- 아래 내용은 회사·직무에 관한 참고정보이며 지원자의 과거 경험이 아니다.",
  "- 지원자가 아래 업무나 성과를 이미 수행했다고 전제하지 않는다.",
  "- resumeText에 실제로 적힌 경험과 자연스럽게 연결될 때만 참고한다.",
  "- 연결되는 경험이 없으면 회사 자료를 사용하지 않고 이력서만으로 질문한다.",
  "- 회사 인재상 암기 여부를 묻지 않는다.",
  "- 뉴스 내용을 지원자가 이미 알고 있다고 전제하지 않는다.",
  "- 회사 자료를 모든 질문에 억지로 사용하지 않는다.",
  "- 기존 질문 반복 방지·관점 제한·grounding 규칙을 그대로 따른다.",
];

function renderContext(
  displayName: string,
  selectedRole: string,
  cultures: Culture[],
  article: Article,
  news: News | undefined
): string {
  const lines: string[] = [];
  lines.push("[선택 회사]", displayName, "");
  lines.push("[선택 직무]", selectedRole, "");
  lines.push("[회사 참고자료 사용 규칙]", ...CONTEXT_RULES, "");

  if (cultures.length > 0) {
    lines.push("[회사 문화 참고]");
    for (const c of cultures) {
      lines.push(`- 값 이름: ${c.name}`);
      if (c.description) lines.push(`  설명: ${c.description}`);
      if (c.behaviors.length) lines.push(`  행동 기준: ${c.behaviors.join(" / ")}`);
    }
    lines.push("");
  }

  lines.push("[선택 직무 참고]");
  lines.push(`- 직무명: ${article.roleName}`);
  if (article.overview) lines.push(`  직무 개요: ${article.overview}`);
  if (article.mainTasks.length) lines.push(`  주요 업무: ${article.mainTasks.join(" / ")}`);
  const skills = Array.from(new Set([...article.competencies, ...article.requiredKnowledge]));
  if (skills.length) lines.push(`  요구 역량: ${skills.join(" / ")}`);
  if (article.sourceUrl) lines.push(`  출처 URL: ${article.sourceUrl}`);
  lines.push("");

  if (news) {
    lines.push("[관련 최근 이슈]");
    lines.push(`- 제목: ${news.title}`);
    if (news.publishedAt) lines.push(`  게시일: ${news.publishedAt}`);
    if (news.sourceName) lines.push(`  언론사: ${news.sourceName}`);
    if (news.summary) lines.push(`  요약: ${news.summary}`);
    if (news.keyFacts.length) lines.push(`  핵심 사실: ${news.keyFacts.join(" / ")}`);
    if (news.sourceUrl) lines.push(`  출처 URL: ${news.sourceUrl}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// 첫 질문 앵커 — work_culture → official_article → external_news 우선순위.
// ─────────────────────────────────────────────────────────────────────────────
function makeAnchor(
  contentType: CompanyAnchor["contentType"],
  displayName: string,
  officialName: string,
  coreContent: string,
  detailLines: (string | false | null | undefined)[]
): CompanyAnchor {
  const contentTypeLabel = CONTENT_TYPE_LABELS[contentType];
  const core = (coreContent ?? "").trim();
  const basis = core
    ? `${displayName} ${contentTypeLabel} — ${officialName}:\n"${core}"`
    : `${displayName} ${contentTypeLabel} — ${officialName}`;
  const promptMaterial = [
    "[회사 공식 자료 — 첫 질문 근거]",
    `- 구분: ${contentTypeLabel}`,
    `- 항목: ${officialName}`,
    ...detailLines.filter((l): l is string => typeof l === "string" && l.length > 0),
  ].join("\n");
  return { contentType, contentTypeLabel, officialName, coreContent: core, basis, promptMaterial };
}

function pickCompanyAnchor(
  displayName: string,
  cultures: Culture[],
  article: Article | undefined,
  news: News | undefined
): CompanyAnchor | undefined {
  const culture = cultures.find((c) => (c.name ?? "").trim());
  if (culture) {
    const core = (culture.description || culture.behaviors[0] || "").trim();
    return makeAnchor("work_culture", displayName, culture.name.trim(), core, [
      culture.description && `- 설명: ${culture.description}`,
      culture.behaviors.length > 0 && `- 행동 기준: ${culture.behaviors.join(" / ")}`,
    ]);
  }
  if (article && (article.roleName ?? "").trim()) {
    const skills = Array.from(new Set([...article.competencies, ...article.requiredKnowledge]));
    const core = (skills.join(" / ") || article.mainTasks.join(" / ") || article.overview || "").trim();
    return makeAnchor("official_article", displayName, article.roleName.trim(), core, [
      article.overview && `- 직무 개요: ${article.overview}`,
      article.mainTasks.length > 0 && `- 주요 업무: ${article.mainTasks.join(" / ")}`,
      skills.length > 0 && `- 요구 역량: ${skills.join(" / ")}`,
    ]);
  }
  if (news && (news.title ?? "").trim()) {
    const core = (news.summary || news.keyFacts[0] || "").trim();
    return makeAnchor("external_news", displayName, news.title.trim(), core, [
      news.publishedAt && `- 게시일: ${news.publishedAt}`,
      news.summary && `- 요약: ${news.summary}`,
      news.keyFacts.length > 0 && `- 핵심 사실: ${news.keyFacts.join(" / ")}`,
    ]);
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 진입점.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 회사·직무·이력서로부터 면접 시작용 context 문자열·첫 질문 앵커를 만든다.
 *  - 빈 회사 / company_contexts 조회 0건 / DB 실패 / 앵커 못 고름
 *    → context·anchor = undefined (기존 resumeText 기반 면접으로 진행).
 */
export async function buildCompanyContext(
  companyName: string,
  selectedRole: string,
  resumeText: string
): Promise<CompanyContextResult> {
  const base: CompanyContextResult = {
    context: undefined,
    companyMatched: false,
    displayName: undefined,
    companyKey: undefined,
    selectedRole: (selectedRole ?? "").trim(),
    dbConnected: undefined,
    workCulture: [],
    officialArticle: undefined,
    externalNews: undefined,
    notice: undefined,
  };

  // (a) 회사 입력 비어 있음 → DB 조회 없음, resume-only.
  if (!(companyName ?? "").trim()) return base;

  // (b) company_key 결정(레지스트리 별칭 우선, 없으면 slug).
  const company = resolveCompany(companyName);
  if (!company) return base;
  base.companyMatched = true;
  base.displayName = company.displayName;
  base.companyKey = company.companyKey;

  // (c) DB SELECT(읽기 전용). 실패하면 context 없이 진행.
  let rows: DbRow[];
  try {
    rows = await fetchCompanyRows(company.companyKey);
    base.dbConnected = true;
  } catch {
    return { ...base, dbConnected: false, notice: FALLBACK_NOTICE };
  }
  // (b') 식별은 됐으나 수집 데이터가 아직 없는 회사 → JIT 수집 대상 표시 + 미등록 안내 + resume-only.
  if (!rows || rows.length === 0) return { ...base, dataMissing: true, notice: UNREGISTERED_NOTICE };

  // (d) 파싱.
  const cultures = rows.filter((r) => r.content_type === "work_culture").flatMap(extractCultures);
  const articles = rows.filter((r) => r.content_type === "official_article").map(extractArticle);
  const newsList = rows.filter((r) => r.content_type === "external_news").map(extractNews);

  // (e) 직무 매칭 기사(rich context 의 게이트).
  const article = pickRoleArticle(articles, base.selectedRole);
  if (article) base.officialArticle = { roleName: article.roleName, sourceUrl: article.sourceUrl };

  // (f) 회사 문화 ≤2, 최근 이슈 ≤1.
  const roleKeywords = article
    ? tokenize(
        article.roleName,
        article.aliases,
        article.overview,
        article.mainTasks,
        article.subAreas,
        article.requiredKnowledge,
        article.competencies
      )
    : [];
  const cultureKeywords = Array.from(new Set([...roleKeywords, ...tokenize(resumeText)]));

  const pickedCultures = pickCultures(cultures, cultureKeywords);
  base.workCulture = pickedCultures.map((c) => ({ key: c.key, name: c.name }));

  // 뉴스 앵커 관련성: 직무 + 이력서 키워드로 평가한다(공식 기사 유무와 무관).
  //  - 직무/이력서와 겹치는 뉴스가 있을 때만 채택한다. 없으면 채택하지 않는다(아래 (g) 참고).
  const newsKeywords = Array.from(
    new Set([...tokenize(base.selectedRole), ...roleKeywords, ...tokenize(resumeText)])
  );
  const pickedNews = pickNews(newsList, newsKeywords);
  if (pickedNews) base.externalNews = { title: pickedNews.title, publishedAt: pickedNews.publishedAt };

  // (g) 첫 질문 앵커.
  //     관련 없는 뉴스(예: 회사 CSR·행사 기사)로 억지 앵커를 만들지 않는다.
  //     work_culture/official_article 가 없고 직무·이력서와 관련된 뉴스도 없으면 anchor 는 비고,
  //     아래에서 resume-only(이력서 기반) 면접으로 안전하게 진행된다.
  base.companyAnchor = pickCompanyAnchor(company.displayName, pickedCultures, article, pickedNews);

  // (h) rich context 렌더 — 직무 매칭 기사가 있을 때만.
  if (article) {
    try {
      base.context = renderContext(company.displayName, base.selectedRole, pickedCultures, article, pickedNews);
    } catch {
      base.context = undefined;
    }
  }

  if (!base.companyAnchor) return { ...base, notice: FALLBACK_NOTICE };
  return base;
}

/**
 * 데이터 없는 회사를 JIT 수집 큐(company_ingest_requests)에 넣는다(디바운스).
 *  - 회사당 'pending' 1건만 허용하는 부분 유니크 인덱스 → ON CONFLICT DO NOTHING.
 *  - 면접 흐름을 막지 않도록 fire-and-forget 으로 호출하고, 실패는 조용히 무시한다.
 *  - 실제 수집은 호스트의 파이프라인 러너(`run.py --drain`, cron)가 처리한다.
 */
export async function enqueueCompanyIngest(companyKey: string, companyName: string): Promise<void> {
  if (!companyKey || !companyName) return;
  try {
    await pool.query(
      `INSERT INTO company_ingest_requests (company_key, company_name, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (company_key) WHERE status = 'pending' DO NOTHING`,
      [companyKey, companyName]
    );
  } catch {
    // 큐 적재 실패는 면접에 영향 없음(다음 기회에 다시 시도).
  }
}
