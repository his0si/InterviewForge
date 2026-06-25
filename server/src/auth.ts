// 인증 라우트: 회원가입 → 메일 인증 → 로그인 → 세션 확인 → 로그아웃.
// 참고 앱과 달리 "이메일 도메인 제한이 없다" — 형식만 맞으면 어떤 도메인이든 가입 가능.
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type {
  AuthError,
  LoginResponse,
  MeResponse,
  PublicUser,
  RegisterResponse,
} from "@e-lifethon/shared";
import { pool } from "./db.js";
import { sendVerificationEmail, APP_URL } from "./email.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const COOKIE_NAME = "if_token";
const TOKEN_TTL_HOURS = 24;
// 운영에선 HTTPS(같은 출처) 이므로 secure 쿠키. 개발(http)에선 secure 끄기.
const IS_PROD = process.env.NODE_ENV === "production";

// 도메인 제한 없는 일반적인 이메일 형식 검사.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 쿠키(if_token)에서 로그인 사용자 id 를 꺼낸다. 없으면 null.
function currentUserId(req: { cookies?: Record<string, string | undefined> }): number | null {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  try {
    const payload = jwt.verify(raw, JWT_SECRET) as unknown as { sub: number };
    return payload.sub;
  } catch {
    return null;
  }
}

function toPublicUser(row: {
  id: number;
  email: string;
  nickname: string;
  jobs: string[] | null;
  is_verified: boolean;
  created_at: Date | string;
}): PublicUser {
  return {
    id: row.id,
    email: row.email,
    nickname: row.nickname ?? "",
    jobs: row.jobs ?? [],
    is_verified: row.is_verified,
    created_at:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ── 회원가입 ──────────────────────────────────────────────────────────
  app.post<{
    Body: {
      email?: string;
      password?: string;
      nickname?: string;
      jobs?: unknown;
    };
  }>(
    "/api/auth/register",
    async (req, reply) => {
      const email = (req.body?.email ?? "").trim().toLowerCase();
      const password = req.body?.password ?? "";
      const nickname = (req.body?.nickname ?? "").trim();
      // 직무: 배열에서 공백 제거·빈 값 제외, 최소 1개 필요.
      const jobs = Array.isArray(req.body?.jobs)
        ? (req.body!.jobs as unknown[])
            .map((j) => String(j).trim())
            .filter((j) => j.length > 0)
        : [];

      if (!EMAIL_RE.test(email)) {
        return reply
          .code(400)
          .send({ ok: false, error: "올바른 이메일 형식이 아닙니다." } as AuthError);
      }
      if (password.length < 8) {
        return reply
          .code(400)
          .send({ ok: false, error: "비밀번호는 8자 이상이어야 합니다." } as AuthError);
      }
      if (!nickname) {
        return reply
          .code(400)
          .send({ ok: false, error: "닉네임을 입력해 주세요." } as AuthError);
      }
      if (jobs.length === 0) {
        return reply
          .code(400)
          .send({ ok: false, error: "직무를 최소 1개 입력해 주세요." } as AuthError);
      }

      const existing = await pool.query(
        "SELECT id, is_verified FROM users WHERE email = $1",
        [email]
      );
      if (existing.rowCount && existing.rows[0].is_verified) {
        return reply
          .code(409)
          .send({ ok: false, error: "이미 가입된 이메일입니다." } as AuthError);
      }

      const hash = await bcrypt.hash(password, 12);
      const token = randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000);

      if (existing.rowCount) {
        // 미인증 상태로 남아있던 계정이면 정보/비번/토큰 갱신 후 인증 메일 재발송
        await pool.query(
          `UPDATE users
             SET password = $1, nickname = $2, jobs = $3,
                 verification_token = $4, verification_expires_at = $5
           WHERE id = $6`,
          [hash, nickname, jobs, token, expires, existing.rows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO users (email, password, nickname, jobs, verification_token, verification_expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [email, hash, nickname, jobs, token, expires]
        );
      }

      try {
        await sendVerificationEmail(email, token);
      } catch (err) {
        req.log.error(err, "인증 메일 발송 실패");
        return reply.code(502).send({
          ok: false,
          error: "인증 메일 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        } as AuthError);
      }

      return reply.send({
        ok: true,
        message: "인증 메일을 보냈습니다. 메일함에서 인증을 완료해 주세요.",
      } as RegisterResponse);
    }
  );

  // ── 이메일 인증 (메일의 링크가 GET 으로 호출) ─────────────────────────
  app.get<{ Querystring: { token?: string } }>(
    "/api/auth/verify",
    async (req, reply) => {
      const token = req.query?.token ?? "";
      const row = await pool.query(
        "SELECT id, verification_expires_at FROM users WHERE verification_token = $1",
        [token]
      );
      if (!row.rowCount) {
        return reply.redirect(`${APP_URL}/login?verify=invalid`);
      }
      const userId = row.rows[0].id;
      if (new Date(row.rows[0].verification_expires_at) < new Date()) {
        await pool.query(
          "UPDATE users SET verification_token = NULL, verification_expires_at = NULL WHERE id = $1",
          [userId]
        );
        return reply.redirect(`${APP_URL}/login?verify=expired`);
      }

      await pool.query(
        `UPDATE users
           SET is_verified = TRUE, verification_token = NULL, verification_expires_at = NULL
         WHERE id = $1`,
        [userId]
      );
      return reply.redirect(`${APP_URL}/login?verify=success`);
    }
  );

  // ── 로그인 ────────────────────────────────────────────────────────────
  app.post<{ Body: { email?: string; password?: string } }>(
    "/api/auth/login",
    async (req, reply) => {
      const email = (req.body?.email ?? "").trim().toLowerCase();
      const password = req.body?.password ?? "";

      const row = await pool.query(
        "SELECT id, email, password, nickname, jobs, is_verified, created_at FROM users WHERE email = $1",
        [email]
      );
      const fail = () =>
        reply.code(401).send({
          ok: false,
          error: "이메일 또는 비밀번호가 올바르지 않습니다.",
        } as AuthError);

      if (!row.rowCount) return fail();
      const user = row.rows[0];
      const match = await bcrypt.compare(password, user.password);
      if (!match) return fail();

      if (!user.is_verified) {
        return reply.code(403).send({
          ok: false,
          error: "이메일 인증이 완료되지 않았습니다. 메일함을 확인해 주세요.",
        } as AuthError);
      }

      const jwtToken = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, {
        expiresIn: "7d",
      });
      reply.setCookie(COOKIE_NAME, jwtToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: IS_PROD,
        path: "/",
        maxAge: 7 * 24 * 3600,
      });
      return reply.send({ ok: true, user: toPublicUser(user) } as LoginResponse);
    }
  );

  // ── 현재 로그인 사용자 ────────────────────────────────────────────────
  app.get("/api/auth/me", async (req, reply) => {
    const raw = req.cookies?.[COOKIE_NAME];
    if (!raw) return reply.send({ user: null } as MeResponse);
    try {
      const payload = jwt.verify(raw, JWT_SECRET) as unknown as { sub: number };
      const row = await pool.query(
        "SELECT id, email, nickname, jobs, is_verified, created_at FROM users WHERE id = $1",
        [payload.sub]
      );
      if (!row.rowCount) return reply.send({ user: null } as MeResponse);
      return reply.send({ user: toPublicUser(row.rows[0]) } as MeResponse);
    } catch {
      return reply.send({ user: null } as MeResponse);
    }
  });

  // ── 프로필 수정(닉네임/직무) ──────────────────────────────────────────
  app.patch<{ Body: { nickname?: string; jobs?: unknown } }>(
    "/api/auth/profile",
    async (req, reply) => {
      const userId = currentUserId(req);
      if (!userId) {
        return reply
          .code(401)
          .send({ ok: false, error: "로그인이 필요합니다." } as AuthError);
      }
      const nickname = (req.body?.nickname ?? "").trim();
      const jobs = Array.isArray(req.body?.jobs)
        ? (req.body!.jobs as unknown[])
            .map((j) => String(j).trim())
            .filter((j) => j.length > 0)
        : [];

      if (!nickname) {
        return reply
          .code(400)
          .send({ ok: false, error: "닉네임을 입력해 주세요." } as AuthError);
      }
      if (jobs.length === 0) {
        return reply
          .code(400)
          .send({ ok: false, error: "직무를 최소 1개 입력해 주세요." } as AuthError);
      }

      const row = await pool.query(
        `UPDATE users SET nickname = $1, jobs = $2 WHERE id = $3
         RETURNING id, email, nickname, jobs, is_verified, created_at`,
        [nickname, jobs, userId]
      );
      if (!row.rowCount) {
        return reply
          .code(404)
          .send({ ok: false, error: "사용자를 찾을 수 없습니다." } as AuthError);
      }
      return reply.send({ ok: true, user: toPublicUser(row.rows[0]) });
    }
  );

  // ── 비밀번호 변경 ─────────────────────────────────────────────────────
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    "/api/auth/password",
    async (req, reply) => {
      const userId = currentUserId(req);
      if (!userId) {
        return reply
          .code(401)
          .send({ ok: false, error: "로그인이 필요합니다." } as AuthError);
      }
      const currentPassword = req.body?.currentPassword ?? "";
      const newPassword = req.body?.newPassword ?? "";
      if (newPassword.length < 8) {
        return reply
          .code(400)
          .send({ ok: false, error: "새 비밀번호는 8자 이상이어야 합니다." } as AuthError);
      }

      const row = await pool.query(
        "SELECT password FROM users WHERE id = $1",
        [userId]
      );
      if (!row.rowCount) {
        return reply
          .code(404)
          .send({ ok: false, error: "사용자를 찾을 수 없습니다." } as AuthError);
      }
      const match = await bcrypt.compare(currentPassword, row.rows[0].password);
      if (!match) {
        return reply
          .code(400)
          .send({ ok: false, error: "현재 비밀번호가 올바르지 않습니다." } as AuthError);
      }

      const hash = await bcrypt.hash(newPassword, 12);
      await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hash, userId]);
      return reply.send({ ok: true, message: "비밀번호가 변경되었습니다." });
    }
  );

  // ── 로그아웃 ──────────────────────────────────────────────────────────
  app.post("/api/auth/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return reply.send({ ok: true });
  });
}
