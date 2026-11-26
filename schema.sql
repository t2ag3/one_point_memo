-- 1 日の回数制限（lib/guard.js）の表。README の「D1 を作る」で使う
CREATE TABLE IF NOT EXISTS usage (
  day TEXT NOT NULL,          -- 日本時間の日付（2026-11-26）
  key TEXT NOT NULL,          -- 接続元のハッシュ（ip:…）か、全体（_total）
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
