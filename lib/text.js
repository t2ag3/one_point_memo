// 照合用の文字の扱い（memo_text.py の normalize・numbers と同じ処理）。

// 全角・半角をそろえ、空白・数値のカンマを除き、2 種類の白丸を 1 つにする
export function normalize(text) {
  let t = String(text ?? "").normalize("NFKC").replaceAll("〇", "○");
  t = t.replace(/(?<=\d),(?=\d{3})/g, "");
  return t.replace(/\s+/g, "");
}

// 文の中の数値（正規化した後の 2 桁以上か小数）を集める。漏れチェックに使う
export function numbers(text) {
  const found = normalize(text).match(/\d+(?:\.\d+)?/g) || [];
  return new Set(found.filter((n) => n.length >= 2));
}
