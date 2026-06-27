// 로컬 LLM(Ollama) 클라이언트. 크롤러(crawler/llm.py)와 같은 Ollama 인스턴스를 쓴다.
// - 보안 요구사항: 모든 추론을 로컬에서 처리(데이터가 외부로 나가지 않음).
// - 생성: exaone3.5(한국어 특화), 임베딩: bge-m3(다국어, 1024차원).
// - 이력서 분석 / 면접 질문 생성 / 공고 추천이 공용으로 사용한다.

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "exaone3.5:latest";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "bge-m3:latest";

export class OllamaError extends Error {}

// 모델 응답을 JSON 으로 파싱하지 못했을 때의 오류(연결 실패와 구분).
// AI 면접 엔진은 이 오류만 잡아 "필수 필드 fallback" 으로 흐름을 계속 진행시킨다.
export class OllamaJsonError extends OllamaError {}

// fetch + 타임아웃. Ollama 가 죽어 있으면 호출부에서 잡아 graceful 하게 처리한다.
async function postJson(path: string, body: unknown, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new OllamaError(`Ollama ${path} ${res.status}: ${await res.text()}`);
    return await res.json();
  } catch (err) {
    if (err instanceof OllamaError) throw err;
    throw new OllamaError(`Ollama 호출 실패(${path}): ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

type GenOpts = { temperature?: number; numCtx?: number; timeoutMs?: number; model?: string };

// 자유 텍스트 생성(마크다운 피드백 등).
export async function generate(prompt: string, opts: GenOpts = {}): Promise<string> {
  const data = await postJson(
    "/api/generate",
    {
      model: opts.model || OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: opts.temperature ?? 0.2, num_ctx: opts.numCtx ?? 8192 },
    },
    opts.timeoutMs ?? 180_000
  );
  return String(data.response ?? "").trim();
}

// 한 번 호출해 원본 응답 문자열을 받는다(format:"json").
async function callJsonRaw(prompt: string, opts: GenOpts): Promise<string> {
  const data = await postJson(
    "/api/generate",
    {
      model: opts.model || OLLAMA_MODEL,
      prompt,
      stream: false,
      format: "json",
      options: { temperature: opts.temperature ?? 0.1, num_ctx: opts.numCtx ?? 8192 },
    },
    opts.timeoutMs ?? 180_000
  );
  return String(data.response ?? "").trim();
}

// 느슨한 JSON 파싱. 성공하면 파싱값을, 실패하면 undefined(예외 없음).
// 모델이 코드펜스/잡설로 감싸는 경우 첫 { ~ 마지막 }(또는 [ ~ ])를 한 번 더 구제한다.
function tryParseJson<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const m = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        /* fallthrough */
      }
    }
    return undefined;
  }
}

// JSON 강제 생성(구조화 추출). format:"json" 으로 파싱 안정성을 높인다.
// 1차 응답이 깨지면 "JSON 만 출력" 을 강하게 요청해 한 번 더 재시도하고,
// 그래도 실패하면 OllamaJsonError 를 던진다(호출부가 fallback 으로 처리할 수 있게).
export async function generateJson<T = unknown>(prompt: string, opts: GenOpts = {}): Promise<T> {
  const first = await callJsonRaw(prompt, opts);
  const parsed = tryParseJson<T>(first);
  if (parsed !== undefined) return parsed;

  const retryPrompt =
    `${prompt}\n\n` +
    `[재요청] 직전 출력이 JSON 으로 파싱되지 않았습니다. ` +
    `코드펜스/설명/주석 없이, 명시된 형식의 유효한 JSON 객체 하나만 출력하세요.`;
  const second = await callJsonRaw(retryPrompt, opts);
  const reparsed = tryParseJson<T>(second);
  if (reparsed !== undefined) return reparsed;

  throw new OllamaJsonError(`LLM JSON 파싱 실패(재시도 후). 모델 원본 응답:\n${second.slice(0, 500)}`);
}

// 임베딩 벡터(bge-m3, 1024차원). 추천 의미검색에 사용.
export async function embed(text: string, opts: { timeoutMs?: number } = {}): Promise<number[]> {
  const input = (text || "").slice(0, 8000); // 과도하게 긴 입력 방지
  const data = await postJson(
    "/api/embed",
    { model: OLLAMA_EMBED_MODEL, input },
    opts.timeoutMs ?? 60_000
  );
  const vec = data?.embeddings?.[0] ?? data?.embedding;
  if (!Array.isArray(vec)) throw new OllamaError("임베딩 응답 형식 오류");
  return vec as number[];
}

// 헬스 체크(설정 화면/디버깅용).
export async function ollamaHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export const ollamaConfig = { url: OLLAMA_URL, model: OLLAMA_MODEL, embedModel: OLLAMA_EMBED_MODEL };
