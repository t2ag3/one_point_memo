// 有料・回数制限つきの AI を、だれでも呼べる口から守る。
// - Turnstile（ロボット対策）：TURNSTILE_SECRET があるときだけ、始めるときに確かめる
// - 1 日の回数制限：D1（binding 名 DB）があるときだけ、AI を呼ぶたびに数える
//     DAILY_LIMIT_PER_IP（既定 60）・DAILY_LIMIT_TOTAL（既定 2000）。日付の区切りは日本時間
//     接続元はそのまま保存せず、SESSION_SECRET を混ぜたハッシュにして保存する
// 表は README の「D1 を作る」のとおり：usage(day TEXT, key TEXT, count INTEGER, PRIMARY KEY(day, key))

import { HttpError } from "./http.js";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

export async function checkTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return;
  if (!token) throw new HttpError("ロボット対策の確認ができていません。ページを開き直してください。", 403);
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  form.append("remoteip", ip);
  const doFetch = env.FETCH || fetch;
  let ok = false;
  try {
    const res = await doFetch(SITEVERIFY, { method: "POST", body: form });
    ok = Boolean((await res.json()).success);
  } catch { ok = false; }
  if (!ok) throw new HttpError("ロボット対策の確認に失敗しました。ページを開き直してください。", 403);
}

function utf8(text) {
  const bin = unescape(encodeURIComponent(text));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hashed(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(text)));
  return [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function today(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // 日本時間の日付
}

async function bump(db, day, key) {
  const row = await db.prepare(
    "INSERT INTO usage (day, key, count) VALUES (?1, ?2, 1) "
    + "ON CONFLICT (day, key) DO UPDATE SET count = count + 1 RETURNING count",
  ).bind(day, key).first();
  return row ? Number(row.count) : 0;
}

// AI を 1 回呼ぶ前に数える。上限を超えたら 429
export async function countUse(env, ip, now = Date.now()) {
  if (!env.DB) return;
  const day = today(now);
  const perIp = Number(env.DAILY_LIMIT_PER_IP || 60);
  const total = Number(env.DAILY_LIMIT_TOTAL || 2000);
  const mine = await bump(env.DB, day, "ip:" + (await hashed(`${env.SESSION_SECRET || ""}|${ip}`)));
  if (mine > perIp) throw new HttpError(`今日の利用の上限（${perIp} 回）に達しました。明日また挑んでください。`, 429);
  const all = await bump(env.DB, day, "_total");
  if (all > total) throw new HttpError("今日は全体の利用の上限に達しました。明日また挑んでください。", 429);
}
