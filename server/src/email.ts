// 회원가입 인증 메일 발송 (Gmail SMTP / 앱 비밀번호).
//  - SMTP_USER: 보내는 Gmail 주소 (예: his0si2276@gmail.com)
//  - SMTP_PASS: 해당 Gmail 의 "앱 비밀번호" 16자리 (일반 비번 아님)
//  - APP_URL : 인증 링크의 베이스 URL (예: https://interviewforge.kro.kr)
import nodemailer from "nodemailer";

const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;
export const APP_URL = process.env.APP_URL || "http://localhost:5210";

// SMTP 설정이 없으면 메일 발송을 건너뛰고 콘솔에 링크만 찍는다(로컬 개발 편의).
const transporter =
  SMTP_USER && SMTP_PASS
    ? nodemailer.createTransport({
        service: "gmail",
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      })
    : null;

export async function sendVerificationEmail(
  to: string,
  token: string
): Promise<void> {
  const link = `${APP_URL}/api/auth/verify?token=${encodeURIComponent(token)}`;

  if (!transporter) {
    // 개발 모드: 실제 발송 대신 링크 출력
    console.log(`[email] (SMTP 미설정) ${to} 인증 링크: ${link}`);
    return;
  }

  await transporter.sendMail({
    from: `InterviewForge <${SMTP_FROM}>`,
    to,
    subject: "[InterviewForge] 이메일 인증을 완료해 주세요",
    html: `
      <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>InterviewForge 이메일 인증</h2>
        <p>아래 버튼을 눌러 이메일 인증을 완료하면 로그인할 수 있습니다.</p>
        <p style="margin: 24px 0;">
          <a href="${link}"
             style="background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">
            이메일 인증하기
          </a>
        </p>
        <p style="color:#666;font-size:13px;">버튼이 안 되면 이 링크를 복사해 주세요:<br>${link}</p>
        <p style="color:#999;font-size:12px;">이 링크는 24시간 후 만료됩니다. 본인이 요청하지 않았다면 무시하세요.</p>
      </div>
    `,
  });
}
