// テスト用の偽物：OpenRouter・Turnstile の確認先（fetch を差し替える）と D1。

// replies：OpenRouter が順に返す答え（オブジェクトは JSON にして返す。文字列はそのまま。{status} で失敗を返す）
export function fakeOpenRouter(...replies) {
  const calls = [];
  const turnstile = [];
  const fetchFn = async (url, opts = {}) => {
    if (String(url).includes("turnstile")) {
      turnstile.push(opts.body);
      return new Response(JSON.stringify({ success: opts.body.get("response") === "good" }));
    }
    calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (r && r.status) return new Response(JSON.stringify({ error: { message: "失敗" } }), { status: r.status });
    const content = typeof r === "string" ? r : JSON.stringify(r);
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  };
  return { fetch: fetchFn, calls, turnstile };
}

export function fakeD1() {
  const rows = new Map();
  return {
    rows,
    prepare: () => ({
      bind: (day, key) => ({
        first: async () => {
          const k = `${day}|${key}`;
          rows.set(k, (rows.get(k) || 0) + 1);
          return { count: rows.get(k) };
        },
      }),
    }),
  };
}

// 決まった並びの乱数（0 から順に回る）
export function steadyRandom() {
  let i = 0;
  return () => ((i++ * 0.37) % 1);
}
