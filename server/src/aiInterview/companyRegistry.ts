// 회사 식별 단일 소스(Single source of truth).
//  - 수집 파이프라인과 면접 어댑터가 "같은 회사 → 같은 company_key" 규칙을 공유한다.
//  - 기본 규칙: company_key = slugifyCompany(공고의 회사명). 코드 수정 없이 회사가 추가된다.
//  - 큐레이션 별칭(CURATED): 표기가 흔들리는 회사("SK하이닉스" vs "에스케이하이닉스")나
//    수동 수집된 회사(sk_hynix)는 여기서 명시적으로 키/표시명/별칭을 고정한다.
//
// ⚠️ 이 파일은 회사명을 "테이블명/SQL"로 조합하지 않는다. company_key 는 항상
//    파라미터 바인딩($1)으로만 쓰여 SQL 인젝션이 불가능하다.

export interface CompanyIdentity {
  /** company_contexts.company_key 값. 영문 소문자+언더스코어. */
  companyKey: string;
  /** 사용자/프롬프트 노출용 표시명. */
  displayName: string;
}

/** 회사명 → company_key 결정 규칙. 공고의 company 문자열과 파이프라인이 동일하게 호출한다. */
export function slugifyCompany(name: string): string {
  return (name ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\(주\)|주식회사|㈜/g, "")
    .replace(/[^0-9a-z가-힣]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

/** 큐레이션 회사(표기 흔들림·수동 수집 회사). aliases 는 모두 normalize 비교된다. */
interface CuratedCompany extends CompanyIdentity {
  aliases: string[];
}

export const CURATED_COMPANIES: CuratedCompany[] = [
  {
    companyKey: "sk_hynix",
    displayName: "SK하이닉스",
    aliases: ["SK하이닉스", "sk하이닉스", "SK hynix", "SK Hynix", "sk hynix", "하이닉스", "에스케이하이닉스"],
  },
  {
    companyKey: "samsung_electronics",
    displayName: "삼성전자",
    aliases: ["삼성전자", "Samsung Electronics", "samsung electronics", "samsung", "삼성"],
  },
];

function normalize(s: string): string {
  return (s ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 회사명 문자열 → 회사 식별자.
 *  1) 큐레이션 별칭과 정규화 일치하면 그 회사.
 *  2) 아니면 slug 규칙으로 company_key 를 만들고 표시명은 입력값을 그대로 쓴다.
 *  빈 문자열이면 undefined.
 */
export function resolveCompany(companyName: string): CompanyIdentity | undefined {
  const n = normalize(companyName);
  if (!n) return undefined;
  const curated = CURATED_COMPANIES.find((c) => c.aliases.some((a) => normalize(a) === n));
  if (curated) return { companyKey: curated.companyKey, displayName: curated.displayName };
  const key = slugifyCompany(companyName);
  if (!key) return undefined;
  return { companyKey: key, displayName: companyName.trim() };
}
