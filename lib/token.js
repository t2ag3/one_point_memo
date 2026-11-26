// 地獄級の対話の状態を、署名（HMAC-SHA256）付きのトークンとしてブラウザに持たせる。
// サーバーはデータベースを持たない。トークンを書き換えると署名が合わなくなり、断る。

export const TOKEN_SECONDS = 2 * 60 * 60; // 2 時間で無効

export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenError";
  }
}

const encoder = new TextEncoder();

function encodeBase64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(text) {
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function hmac(secret, data) {
  if (!secret || secret.length < 16) throw new TokenError("SESSION_SECRET が設定されていません（16 文字以上）");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const BROKEN = "挑戦の情報が正しくありません。最初から始めてください。";

// payload に有効期限（exp）を付けて署名する
export async function sign(payload, secret, now = Date.now()) {
  const body = encodeBase64Url(encoder.encode(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + TOKEN_SECONDS })));
  return `${body}.${encodeBase64Url(await hmac(secret, body))}`;
}

// 署名と期限を確かめて、中身を返す
export async function verify(token, secret, now = Date.now()) {
  const [body, sig] = String(token ?? "").split(".");
  if (!body || !sig) throw new TokenError(BROKEN);
  let given, payload;
  try { given = decodeBase64Url(sig); } catch { throw new TokenError(BROKEN); }
  if (!sameBytes(given, await hmac(secret, body))) throw new TokenError("挑戦の情報が書き換えられています。最初から始めてください。");
  try { payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(body))); } catch { throw new TokenError(BROKEN); }
  if (!payload.exp || payload.exp * 1000 < now) throw new TokenError("時間がたったため、この挑戦は終わりました。最初から始めてください。");
  return payload;
}
