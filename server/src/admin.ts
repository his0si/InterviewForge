// 관리자(마스터) 전용 라우트: 사이트별 크롤링 설정 조회/수정 + 수동 실행.
// 모든 라우트는 is_admin=TRUE 계정만 통과한다(일반 가입자는 403).
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  AuthError,
  CrawlMode,
  CrawlSetting,
  CrawlSettingsResponse,
} from "@e-lifethon/shared";
import { pool } from "./db.js";
import { currentUserId } from "./auth.js";

// 요청자가 마스터인지 확인. 통과하면 userId, 아니면 reply 에 에러를 싣고 null.
async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<number | null> {
  const userId = currentUserId(req);
  if (!userId) {
    reply.code(401).send({ ok: false, error: "로그인이 필요합니다." } as AuthError);
    return null;
  }
  const row = await pool.query("SELECT is_admin FROM users WHERE id = $1", [userId]);
  if (!row.rowCount || !row.rows[0].is_admin) {
    reply.code(403).send({ ok: false, error: "관리자 권한이 필요합니다." } as AuthError);
    return null;
  }
  return userId;
}

// crawl_settings 한 행 + 대기 중 명령 여부 → 화면용 CrawlSetting 으로.
function toCrawlSetting(row: {
  source: string;
  label: string;
  implemented: boolean;
  interval_hours: number;
  mode: string;
  enabled: boolean;
  last_run_at: Date | string | null;
  last_status: string | null;
  pending: boolean;
}): CrawlSetting {
  const iso = (v: Date | string | null) =>
    v == null ? null : v instanceof Date ? v.toISOString() : String(v);
  const lastRun = iso(row.last_run_at);
  // 다음 예정 시각: auto + enabled 일 때만 (마지막 실행 + 주기). 한 번도 안 돌았으면 "지금".
  let nextRun: string | null = null;
  if (row.enabled && row.mode === "auto") {
    nextRun = lastRun
      ? new Date(new Date(lastRun).getTime() + row.interval_hours * 3600 * 1000).toISOString()
      : new Date().toISOString();
  }
  return {
    source: row.source,
    label: row.label,
    implemented: row.implemented,
    interval_hours: row.interval_hours,
    mode: (row.mode === "manual" ? "manual" : "auto") as CrawlMode,
    enabled: row.enabled,
    last_run_at: lastRun,
    next_run_at: nextRun,
    last_status: row.last_status,
    pending: row.pending,
  };
}

const SELECT_SETTINGS = `
  SELECT cs.source, cs.label, cs.implemented, cs.interval_hours, cs.mode,
         cs.enabled, cs.last_run_at, cs.last_status,
         EXISTS (
           SELECT 1 FROM crawl_commands cc
           WHERE cc.source = cs.source AND cc.status IN ('pending', 'running')
         ) AS pending
  FROM crawl_settings cs
`;
const LIST_SQL = `${SELECT_SETTINGS} ORDER BY cs.implemented DESC, cs.source`;
const ONE_SQL = `${SELECT_SETTINGS} WHERE cs.source = $1`;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── 사이트별 크롤링 설정 목록 ─────────────────────────────────────────
  app.get("/api/admin/crawl-settings", async (req, reply) => {
    if ((await requireAdmin(req, reply)) == null) return;
    const rows = await pool.query(LIST_SQL);
    return reply.send({ items: rows.rows.map(toCrawlSetting) } as CrawlSettingsResponse);
  });

  // ── 한 사이트 설정 수정(주기/모드/활성화) ─────────────────────────────
  app.patch<{
    Params: { source: string };
    Body: { interval_hours?: number; mode?: string; enabled?: boolean };
  }>("/api/admin/crawl-settings/:source", async (req, reply) => {
    if ((await requireAdmin(req, reply)) == null) return;
    const source = req.params.source;

    // 부분 수정: 들어온 필드만 검증·반영.
    const sets: string[] = [];
    const params: unknown[] = [];
    const body = req.body ?? {};

    if (body.interval_hours !== undefined) {
      const h = Math.round(Number(body.interval_hours));
      if (!Number.isFinite(h) || h < 1 || h > 720) {
        return reply
          .code(400)
          .send({ ok: false, error: "주기는 1~720시간 사이여야 합니다." } as AuthError);
      }
      params.push(h);
      sets.push(`interval_hours = $${params.length}`);
    }
    if (body.mode !== undefined) {
      if (body.mode !== "auto" && body.mode !== "manual") {
        return reply
          .code(400)
          .send({ ok: false, error: "모드는 auto 또는 manual 이어야 합니다." } as AuthError);
      }
      params.push(body.mode);
      sets.push(`mode = $${params.length}`);
    }
    if (body.enabled !== undefined) {
      params.push(Boolean(body.enabled));
      sets.push(`enabled = $${params.length}`);
    }
    if (sets.length === 0) {
      return reply
        .code(400)
        .send({ ok: false, error: "수정할 내용이 없습니다." } as AuthError);
    }

    params.push(source);
    const upd = await pool.query(
      `UPDATE crawl_settings SET ${sets.join(", ")}, updated_at = now()
       WHERE source = $${params.length}`,
      params
    );
    if (!upd.rowCount) {
      return reply
        .code(404)
        .send({ ok: false, error: "해당 출처를 찾을 수 없습니다." } as AuthError);
    }
    // 갱신된 한 행을 돌려준다(화면 즉시 반영).
    const row = await pool.query(ONE_SQL, [source]);
    return reply.send(toCrawlSetting(row.rows[0]));
  });

  // ── 수동 실행: 큐에 한 줄 넣으면 크롤러가 폴링해서 처리 ────────────────
  app.post<{ Params: { source: string } }>(
    "/api/admin/crawl-settings/:source/run",
    async (req, reply) => {
      if ((await requireAdmin(req, reply)) == null) return;
      const source = req.params.source;

      const cs = await pool.query(
        "SELECT implemented FROM crawl_settings WHERE source = $1",
        [source]
      );
      if (!cs.rowCount) {
        return reply
          .code(404)
          .send({ ok: false, error: "해당 출처를 찾을 수 없습니다." } as AuthError);
      }
      if (!cs.rows[0].implemented) {
        return reply
          .code(400)
          .send({ ok: false, error: "아직 구현되지 않은 출처입니다." } as AuthError);
      }
      // 이미 대기/진행 중인 명령이 있으면 중복 큐잉 방지.
      const dup = await pool.query(
        "SELECT 1 FROM crawl_commands WHERE source = $1 AND status IN ('pending','running')",
        [source]
      );
      if (dup.rowCount) {
        return reply.send({ ok: true, message: "이미 실행 대기 중입니다." });
      }
      await pool.query(
        "INSERT INTO crawl_commands (source, status) VALUES ($1, 'pending')",
        [source]
      );
      return reply.send({ ok: true, message: "수동 실행을 요청했습니다." });
    }
  );
}
