// 바닥글에 생성 시각을 채운다
(async function showGeneratedAt() {
  const target = document.getElementById("generated-at");
  try {
    const res = await fetch("data/meta.json", { cache: "no-store" });
    if (!res.ok) throw new Error(res.status);
    const meta = await res.json();
    target.textContent = formatKst(meta.generated_at);
  } catch (e) {
    target.textContent = "알 수 없음 (정보를 불러오지 못했어요)";
  }
})();

// "2026-10-14T21:05:00+09:00" → "2026년 10월 14일 21:05 (한국시간)"
function formatKst(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  if (!m) return "알 수 없음";
  return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일 ${m[4]}:${m[5]} (한국시간)`;
}
