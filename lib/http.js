// Functions の応答とエラーの共通の部分。

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const MAX_BODY = 200 * 1024; // トークン（やりとり全部）を含めても十分な大きさ

export async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError("送られた内容が大きすぎます。", 413);
  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch { /* 下で断る */ }
  throw new HttpError("JSON で送ってください。");
}

// 処理を包み、HttpError などを画面に出せる JSON のエラーにする
export function handle(fn) {
  return async (context) => {
    try {
      return await fn(context);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (e && e.name === "TokenError") return json({ error: e.message }, 400);
      if (e && e.name === "LlmError") return json({ error: e.message }, e.status || 502);
      console.error(e);
      return json({ error: "サーバーで思いがけない失敗がありました。少し待ってから、やり直してください。" }, 500);
    }
  };
}
