// 채용 공고 임베딩(bge-m3) 백필 워커.
// 크롤러가 채운 job_postings 중 embedding 이 비어 있는 활성 공고를 골라
// 제목+회사+AI요약으로 임베딩을 만들어 저장한다. 추천(의미검색)의 색인이 된다.
import { pool } from "./db.js";
import { embed } from "./ollama.js";

// pgvector 리터럴 문자열로 변환(node-postgres 는 vector 타입을 모르므로 $1::vector 로 캐스팅).
export function toVectorLiteral(vec: number[]): string {
  return "[" + vec.map((n) => (Number.isFinite(n) ? n : 0)).join(",") + "]";
}

// 임베딩 입력 텍스트(요약 위주, 너무 길지 않게).
function jobText(row: Record<string, unknown>): string {
  const parts = [
    row.title,
    row.company,
    row.ai_summary || row.qualifications || row.description,
  ]
    .map((x) => (x ? String(x) : ""))
    .filter(Boolean);
  return parts.join("\n").slice(0, 4000);
}

// 한 배치 처리. 성공 건수 반환. (Ollama 가 죽어 있으면 0을 반환하고 워커가 멈춤)
export async function embedPendingJobs(max = 100): Promise<number> {
  const sel = await pool.query(
    `SELECT id, title, company, ai_summary, qualifications, description
       FROM job_postings
      WHERE is_active = TRUE AND embedding IS NULL AND ai_summary IS NOT NULL
      ORDER BY id DESC
      LIMIT $1`,
    [max]
  );
  let done = 0;
  for (const row of sel.rows) {
    try {
      const vec = await embed(jobText(row));
      await pool.query(
        `UPDATE job_postings SET embedding = $1::vector, embedding_at = now() WHERE id = $2`,
        [toVectorLiteral(vec), row.id]
      );
      done++;
    } catch {
      // 임베딩 호출 실패(보통 Ollama 다운) → 이 배치 중단. 다음 주기에 재시도.
      break;
    }
  }
  return done;
}

let running = false;

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const n = await embedPendingJobs(100);
      if (n === 0) break; // 처리할 게 없거나 Ollama 불가
    }
  } catch (err) {
    console.warn("공고 임베딩 워커 오류:", (err as Error).message);
  } finally {
    running = false;
  }
}

// 부팅 시 1회 + 30분마다 비어 있는 공고 임베딩을 채운다(크롤러가 새 공고를 추가하므로).
export function startJobEmbeddingWorker(): void {
  void drain();
  setInterval(() => void drain(), 30 * 60 * 1000);
}
