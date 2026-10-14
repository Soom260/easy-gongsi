"use strict";

// 화면은 주소 뒤 조건으로 정해진다
//   (없음)            → 처음 화면
//   ?q=삼성           → 검색 결과
//   ?company=005930   → 회사 화면
const DATA_DIR = "data/";
const SITE_NAME = "쉬운 기업 들여다보기";
const DART_SEARCH = "https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=";

const view = document.getElementById("view");
const statusLine = document.getElementById("status");
const input = document.getElementById("q");

// ---------- 작은 도우미 ----------

// 요소를 만든다. 글자는 textContent 로만 넣어서 시트 내용이 HTML 로 해석되지 않게 한다
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// 새 창으로 여는 링크 (화면 읽기 프로그램에는 "새 창"이라고 알려 줌)
function externalLink(href, text) {
  return el("a", { href, target: "_blank", rel: "noopener" }, text, el("span", { class: "sr-only" }, " (새 창)"));
}

async function getJSON(path) {
  const res = await fetch(DATA_DIR + path, { cache: "no-store" });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function setStatus(text) {
  statusLine.textContent = text;
}

// 화면 내용을 바꾸고 탭 제목도 바꾼다
function render(title, ...nodes) {
  view.replaceChildren(...nodes);
  document.title = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}

// 회사 화면을 열면 초점을 회사 이름으로 옮겨서 화면 읽기 프로그램이 바로 읽게 한다
function focusHeading() {
  const h = view.querySelector("h1");
  if (h) {
    h.setAttribute("tabindex", "-1");
    h.focus();
  }
}

// "2026-10-14T21:05:00+09:00" → "2026년 10월 14일 21:05 (한국시간)"
function formatKst(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || "");
  if (!m) return "알 수 없음";
  return `${m[1]}년 ${Number(m[2])}월 ${Number(m[3])}일 ${m[4]}:${m[5]} (한국시간)`;
}

// 검색 비교용: 공백 없애고 소문자로
function normalize(text) {
  return (text || "").replace(/\s+/g, "").toLowerCase();
}

// ---------- 데이터 ----------

let companiesCache = null;
async function loadCompanies() {
  if (!companiesCache) companiesCache = await getJSON("companies.json");
  return companiesCache;
}

function searchCompanies(list, query) {
  const q = normalize(query);
  if (/^\d+$/.test(q)) return list.filter((c) => c.stock_code === q);
  const hits = list.filter((c) => normalize(c.name).includes(q) || normalize(c.official_name).includes(q));
  // 이름이 검색어로 시작하는 회사를 앞에
  return hits.sort((a, b) => {
    const sa = normalize(a.name).startsWith(q) ? 0 : 1;
    const sb = normalize(b.name).startsWith(q) ? 0 : 1;
    return sa - sb || a.name.localeCompare(b.name, "ko");
  });
}

// ---------- 화면: 처음 ----------

async function showHome() {
  setStatus("회사 목록을 불러오는 중이에요…");
  const list = await loadCompanies();
  setStatus("");
  render(
    null,
    el("h1", {}, "회사 찾기"),
    el("p", {}, "회사 이름이나 종목코드로 찾으면, 그 회사의 최근 공시를 쉬운 말로 풀어 보여 드려요."),
    el("h2", {}, `다루는 회사 ${list.length}곳`),
    el(
      "ul",
      { class: "chip-list" },
      list.map((c) => el("li", {}, el("a", { class: "chip", href: `?company=${c.stock_code}` }, c.name)))
    )
  );
}

// ---------- 화면: 검색 결과 ----------

async function showSearch(query) {
  input.value = query;
  setStatus("회사 목록을 불러오는 중이에요…");
  const list = await loadCompanies();
  const results = searchCompanies(list, query);
  setStatus(results.length ? `'${query}' 검색 결과 ${results.length}곳` : `'${query}'에 맞는 회사가 없어요`);

  if (!results.length) {
    render(
      `'${query}' 검색`,
      el("h1", {}, "찾는 회사가 없어요"),
      el("p", {}, `'${query}'에 맞는 회사가 아직 목록에 없어요. 지금은 코스피 시가총액 상위 회사 ${list.length}곳만 다뤄요.`)
    );
    return;
  }

  render(
    `'${query}' 검색`,
    el("h1", {}, `'${query}' 검색 결과 ${results.length}곳`),
    el(
      "ul",
      { class: "result-list" },
      results.map((c) =>
        el(
          "li",
          {},
          el(
            "a",
            { class: "result", href: `?company=${c.stock_code}&q=${encodeURIComponent(query)}` },
            el("span", { class: "result-name" }, c.name),
            el("span", { class: "result-meta" }, `${c.stock_code} · ${c.sector || "업종 정보 없음"}`),
            el("span", { class: "result-meta" }, `최근 90일 공시 ${c.disclosure_count}건`)
          )
        )
      )
    )
  );
}

// ---------- 화면: 회사 ----------

// "[기재정정]반기보고서 (2026.06)" → "반기보고서 (2026.06)" : 같은 종류끼리 묶는 기준
function groupKey(title) {
  return title.replace(/^(\[[^\]]*\])+/, "").trim();
}

// 최신순 목록을 같은 제목끼리 묶는다. 묶음 순서는 가장 최근 공시 순
function groupDisclosures(items) {
  const groups = new Map();
  for (const item of items) {
    const key = groupKey(item.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([title, list]) => ({ title, list }));
}

function explainBox(explain) {
  if (!explain) {
    return el(
      "div",
      { class: "explain explain-none" },
      el("p", {}, "아직 쉬운 설명이 없는 공시예요. 원문에서 내용을 확인해 주세요.")
    );
  }
  return el(
    "div",
    { class: "explain" },
    el("p", {}, el("strong", {}, "쉬운 설명 "), explain.easy),
    explain.why ? el("p", {}, el("strong", {}, "왜 중요할까 "), explain.why) : null
  );
}

function disclosureGroup(group) {
  const latest = group.list[0];
  if (group.list.length === 1) {
    return el(
      "li",
      { class: "disclosure" },
      el("p", { class: "disclosure-date" }, latest.date),
      el("h3", { class: "disclosure-title" }, latest.title),
      explainBox(latest.explain),
      el("p", { class: "disclosure-link" }, externalLink(latest.url, "DART 원문 보기"))
    );
  }
  return el(
    "li",
    { class: "disclosure" },
    el("p", { class: "disclosure-date" }, `가장 최근 ${latest.date}`),
    el("h3", { class: "disclosure-title" }, group.title, " ", el("span", { class: "badge" }, `${group.list.length}건`)),
    explainBox(latest.explain),
    el(
      "details",
      {},
      el("summary", {}, `같은 종류 공시 ${group.list.length}건 모두 보기`),
      el(
        "ul",
        { class: "sub-list" },
        group.list.map((d) => el("li", {}, el("span", { class: "sub-date" }, d.date), " ", externalLink(d.url, d.title)))
      )
    )
  );
}

async function showCompany(code, backQuery) {
  if (backQuery) input.value = backQuery;
  setStatus("회사 정보를 불러오는 중이에요…");

  const list = await loadCompanies();
  const summary = list.find((c) => c.stock_code === code);
  if (!summary) {
    setStatus("다루지 않는 회사예요");
    render(
      "다루지 않는 회사",
      el("h1", {}, "아직 다루지 않는 회사예요"),
      el("p", {}, `종목코드 ${code}는 지금 목록에 없어요. 위 검색 칸에서 다른 회사를 찾아보세요.`)
    );
    return;
  }

  const company = await getJSON(`company/${code}.json`);
  const disc = company.disclosures;
  const groups = groupDisclosures(disc.items);
  setStatus(`${company.name} 정보를 불러왔어요`);

  const back = backQuery
    ? el("a", { class: "back", href: `?q=${encodeURIComponent(backQuery)}` }, `← '${backQuery}' 검색 결과로`)
    : el("a", { class: "back", href: "./" }, "← 처음으로");

  const dartAll = el(
    "p",
    { class: "more" },
    externalLink(DART_SEARCH + encodeURIComponent(company.official_name || company.name), "DART에서 이 회사 공시 전체 검색하기"),
    el("span", { class: "hint" }, " (회사 이름이 검색 칸에 미리 입력돼요)")
  );

  let body;
  if (!disc.items.length) {
    body = [el("p", { class: "empty" }, `${disc.from} ~ ${disc.to} 동안 올라온 공시가 없어요.`), dartAll];
  } else {
    body = [
      el(
        "p",
        { class: "hint" },
        `${disc.from} ~ ${disc.to} · `,
        disc.truncated
          ? `전체 ${disc.total_count}건 중 최신 ${disc.items.length}건을 보여 줘요. 같은 제목의 공시는 한 줄로 묶었어요.`
          : `${disc.items.length}건 · 같은 제목의 공시는 한 줄로 묶었어요.`
      ),
      el("ul", { class: "disclosure-list" }, groups.map(disclosureGroup)),
      dartAll,
    ];
  }

  render(
    company.name,
    back,
    el("h1", {}, company.name),
    el("p", { class: "company-meta" }, `종목코드 ${company.stock_code} · ${company.sector || "업종 정보 없음"} · 정식 이름 ${company.official_name}`),
    el("section", { "aria-labelledby": "disc-heading" }, el("h2", { id: "disc-heading" }, "최근 90일 공시"), ...body)
  );
  focusHeading();
}

// ---------- 오류 (4단계에서 '무슨 일 / 왜 / 할 일'과 다시 시도 버튼으로 다듬음) ----------

function showError(err) {
  console.error(err);
  setStatus("정보를 불러오지 못했어요");
  render(
    "오류",
    el("h1", {}, "정보를 불러오지 못했어요"),
    el("p", {}, "잠시 뒤 새로고침해 주세요.")
  );
}

// ---------- 바닥글 ----------

async function fillFooter() {
  try {
    const meta = await getJSON("meta.json");
    document.getElementById("data-as-of").textContent = formatKst(meta.data_as_of);
    document.getElementById("generated-at").textContent = formatKst(meta.generated_at);
    const terms = (meta.sources || []).find((s) => s.terms_url);
    if (terms) document.getElementById("terms-link").href = terms.terms_url;
  } catch (e) {
    for (const id of ["data-as-of", "generated-at"]) {
      document.getElementById(id).textContent = "알 수 없음 (정보를 불러오지 못했어요)";
    }
  }
}

// ---------- 시작 ----------

async function route() {
  const params = new URLSearchParams(location.search);
  const company = (params.get("company") || "").trim();
  const query = (params.get("q") || "").trim();
  try {
    if (company) await showCompany(company, query);
    else if (query) await showSearch(query);
    else await showHome();
  } catch (err) {
    showError(err);
  }
}

fillFooter();
route();
