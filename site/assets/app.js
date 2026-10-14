"use strict";

// 화면은 주소 뒤 조건으로 정해진다
//   (없음)            → 처음 화면
//   ?q=삼성           → 검색 결과
//   ?company=005930   → 회사 화면
// 시험용 재현 조건 (검증 기록의 근거로 같은 상황을 다시 열 때 사용)
//   &sim=slow   → 3초 동안 불러오는 중 화면을 보여 준 뒤 정상 화면
//   &sim=error  → 불러오기 오류 화면 ('다시 시도'를 누르면 정상 화면)
//   &sim=empty  → 검색 결과 없음 / 최근 공시 없음
const DATA_DIR = "data/";
const SITE_NAME = "쉬운 기업 들여다보기";
const DART_SEARCH = "https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=";
const FETCH_TIMEOUT_MS = 10000;
const SLOW_MS = 3000;
const SIM_MODES = {
  slow: "일부러 3초 늦게 불러오는 시험 화면이에요.",
  error: "불러오기 오류를 일부러 만든 시험 화면이에요. 실제 데이터에는 문제가 없어요.",
  empty: "결과가 없는 상황을 일부러 만든 시험 화면이에요.",
};

const view = document.getElementById("view");
const statusLine = document.getElementById("status");
const form = document.getElementById("search-form");
const input = document.getElementById("q");
const fieldError = document.getElementById("q-error");
const simBanner = document.getElementById("sim-banner");

let sim = null;          // 지금 주소의 재현 조건
let simErrorOn = false;  // sim=error 일 때 첫 시도만 실패시키기 위한 표시

// ---------- 작은 도우미 ----------

// 요소를 만든다. 글자는 textContent 로만 넣어서 시트 내용이 HTML 로 해석되지 않게 한다
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 데이터 파일을 읽는다. 10초 안에 답이 없으면 오류로 본다
async function getJSON(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(DATA_DIR + path, { cache: "no-store", signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") err.timeout = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(text) {
  statusLine.textContent = text;
}

// 화면 내용을 바꾸고 탭 제목도 바꾼다
function render(title, ...nodes) {
  view.removeAttribute("aria-busy");
  view.replaceChildren(...nodes.flat()); // 회사 목록처럼 여러 요소를 묶어 넘겨도 펼쳐서 넣음
  document.title = title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}

// 초점을 새 화면의 제목으로 옮겨서 화면 읽기 프로그램이 바로 읽게 한다
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

// '무슨 일 / 왜 / 할 일' 상자. 오류·빈 결과·잘못된 입력에 함께 쓴다
function problemBox({ what, why, todo, kind = "info", actions = [] }) {
  return el(
    "div",
    { class: `problem problem-${kind}`, role: kind === "error" ? "alert" : null },
    el("h1", {}, what),
    el(
      "dl",
      { class: "problem-lines" },
      el("dt", {}, "왜"), el("dd", {}, why),
      el("dt", {}, "할 일"), el("dd", {}, todo)
    ),
    actions.length ? el("div", { class: "problem-actions" }, actions) : null
  );
}

// ---------- 입력 검증 ----------

// 검색어를 검사한다. 통과하면 { ok: true, value }, 아니면 무슨 일/왜/할 일을 돌려준다
function validateQuery(raw) {
  const value = (raw || "").trim();
  if (!value) {
    return {
      ok: false,
      value,
      what: "검색어가 비어 있어요",
      why: raw ? "공백만으로는 회사를 찾을 수 없어요." : "아무것도 입력하지 않았어요.",
      todo: "회사 이름이나 종목코드를 입력해 주세요. 예: 삼성전자, 005930",
    };
  }
  if (/^\d+$/.test(value)) {
    if (value.length !== 6) {
      return {
        ok: false,
        value,
        what: "종목코드는 6자리 숫자예요",
        why: `숫자만 입력하면 종목코드로 찾는데, 입력한 숫자는 ${value.length}자리예요.`,
        todo: "앞자리 0까지 6자리를 모두 입력해 주세요. 예: 005930",
      };
    }
    return { ok: true, value };
  }
  if (value.length < 2) {
    return {
      ok: false,
      value,
      what: "검색어가 너무 짧아요",
      why: "검색어는 2자 이상이어야 해요.",
      todo: "회사 이름을 두 글자 이상 입력해 주세요. 예: 삼성",
    };
  }
  if (value.length > 20) {
    return {
      ok: false,
      value,
      what: "검색어가 너무 길어요",
      why: `검색어는 20자까지 받을 수 있는데, ${value.length}자를 입력했어요.`,
      todo: "회사 이름만 짧게 입력해 주세요. 예: 현대차",
    };
  }
  return { ok: true, value };
}

// 검색 칸 바로 아래에 안내를 보여 주고, 입력값은 그대로 둔 채 초점을 검색 칸으로 옮긴다
function showFieldError(result) {
  fieldError.replaceChildren(
    el("strong", {}, result.what),
    el("span", {}, result.why),
    el("span", {}, result.todo)
  );
  fieldError.hidden = false;
  input.setAttribute("aria-invalid", "true");
  input.focus();
}

function clearFieldError() {
  fieldError.hidden = true;
  fieldError.replaceChildren();
  input.removeAttribute("aria-invalid");
}

form.addEventListener("submit", (event) => {
  const result = validateQuery(input.value);
  if (!result.ok) {
    event.preventDefault();
    showFieldError(result);
    setStatus(`입력을 확인해 주세요: ${result.what}`);
    return;
  }
  input.value = result.value; // 앞뒤 공백을 정리해서 보냄
});

input.addEventListener("input", () => {
  if (!fieldError.hidden) clearFieldError();
});

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

// 빈 결과 화면에 보여 줄 예시 검색어 (다루는 회사 중에서 고름)
function exampleQueries(list) {
  const names = list.slice(0, 3).map((c) => c.name);
  return list.length ? [...names, list[0].stock_code] : [];
}

// ---------- 화면: 불러오는 중 ----------

function showLoading(message) {
  setStatus(message);
  view.setAttribute("aria-busy", "true");
  const bar = (cls) => el("div", { class: `sk ${cls}` });
  view.replaceChildren(
    el(
      "div",
      { class: "skeleton", "aria-hidden": "true" },
      bar("sk-title"),
      bar("sk-line"),
      [1, 2, 3].map(() => el("div", { class: "sk-card" }, bar("sk-line short"), bar("sk-line"), bar("sk-line")))
    )
  );
}

// ---------- 화면: 처음 ----------

async function showHome() {
  const list = await loadCompanies();
  setStatus("");
  render(
    null,
    el("h1", {}, "회사 찾기"),
    el("p", {}, "회사 이름이나 종목코드로 찾으면, 그 회사의 최근 공시를 쉬운 말로 풀어 보여 드려요."),
    companyChips(list)
  );
}

function companyChips(list) {
  return [
    el("h2", {}, `다루는 회사 ${list.length}곳`),
    el(
      "ul",
      { class: "chip-list" },
      list.map((c) => el("li", {}, el("a", { class: "chip", href: `?company=${c.stock_code}` }, c.name)))
    ),
  ];
}

// ---------- 화면: 검색 결과 ----------

async function showSearch(query) {
  const list = await loadCompanies();
  const results = sim === "empty" ? [] : searchCompanies(list, query);

  if (!results.length) {
    setStatus(`'${query}'에 맞는 회사가 없어요`);
    render(
      `'${query}' 검색`,
      problemBox({
        what: `'${query}'에 맞는 회사가 없어요`,
        why: `지금은 코스피 시가총액 상위 회사 ${list.length}곳만 다뤄요. 회사 이름이 조금 다르게 적혀 있을 수도 있어요.`,
        todo: "아래 예시를 눌러 보거나, 다루는 회사 전체 목록에서 골라 보세요.",
        actions: [
          el(
            "ul",
            { class: "example-list", "aria-label": "예시 검색어" },
            exampleQueries(list).map((ex) =>
              el("li", {}, el("a", { class: "btn-secondary", href: `?q=${encodeURIComponent(ex)}` }, ex))
            )
          ),
          el("p", {}, el("a", { href: "./" }, "다루는 회사 전체 보기")),
        ],
      })
    );
    return;
  }

  setStatus(`'${query}' 검색 결과 ${results.length}곳`);
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
        // 링크 글자에 날짜를 넣어서 같은 제목이 여러 번 나와도 구분되게 한다
        group.list.map((d) => el("li", {}, externalLink(d.url, `${d.date} ${d.title}`)))
      )
    )
  );
}

function invalidCompany(code) {
  setStatus("종목코드를 확인해 주세요");
  render(
    "잘못된 종목코드",
    problemBox({
      what: "종목코드는 6자리 숫자예요",
      why: `주소에 적힌 '${code}'는 6자리 숫자가 아니에요.`,
      todo: "위 검색 칸에서 회사 이름이나 6자리 종목코드로 찾아 주세요. 예: 005930",
      actions: [el("p", {}, el("a", { href: "./" }, "다루는 회사 전체 보기"))],
    })
  );
  focusHeading();
}

async function showCompany(code, backQuery) {
  const list = await loadCompanies();
  const summary = list.find((c) => c.stock_code === code);
  if (!summary) {
    setStatus("아직 다루지 않는 회사예요");
    render(
      "다루지 않는 회사",
      problemBox({
        what: "아직 다루지 않는 회사예요",
        why: `종목코드 ${code}는 지금 목록에 없어요. 지금은 코스피 시가총액 상위 회사 ${list.length}곳만 다뤄요.`,
        todo: "아래 목록에서 다른 회사를 골라 보세요.",
      }),
      companyChips(list)
    );
    focusHeading();
    return;
  }

  const company = await getJSON(`company/${code}.json`);
  const disc = company.disclosures;
  const items = sim === "empty" ? [] : disc.items;
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
  if (!items.length) {
    body = [
      el(
        "div",
        { class: "empty" },
        el("p", {}, el("strong", {}, `${disc.from} ~ ${disc.to} 동안 올라온 공시가 없어요.`)),
        el("p", {}, "왜: 이 기간에 회사가 공시를 내지 않았을 수 있어요."),
        el("p", {}, "할 일: 더 오래된 공시는 아래 DART 링크에서 찾아볼 수 있어요.")
      ),
      dartAll,
    ];
  } else {
    body = [
      el(
        "p",
        { class: "hint" },
        `${disc.from} ~ ${disc.to} · `,
        disc.truncated
          ? `전체 ${disc.total_count}건 중 최신 ${items.length}건을 보여 줘요. 같은 제목의 공시는 한 줄로 묶었어요.`
          : `${items.length}건 · 같은 제목의 공시는 한 줄로 묶었어요.`
      ),
      el("ul", { class: "disclosure-list" }, groupDisclosures(items).map(disclosureGroup)),
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

// ---------- 화면: 오류 ----------

function describeError(err) {
  if (err.simulated) {
    return {
      what: "정보를 불러오지 못했어요",
      why: "(재현) 서버가 응답하지 않는 상황을 일부러 만들었어요. 실제 데이터에는 문제가 없어요.",
      todo: "'다시 시도'를 누르면 정상 화면을 불러와요.",
    };
  }
  if (err.timeout) {
    return {
      what: "정보를 불러오는 데 너무 오래 걸려요",
      why: `${FETCH_TIMEOUT_MS / 1000}초 동안 답이 오지 않았어요. 인터넷 연결이 느리거나 끊겼을 수 있어요.`,
      todo: "연결을 확인하고 '다시 시도'를 눌러 주세요.",
    };
  }
  if (err.status === 404) {
    return {
      what: "정보 파일을 찾지 못했어요",
      why: "사이트를 새로 만드는 중이라 파일이 잠시 없을 수 있어요.",
      todo: "잠시 뒤 '다시 시도'를 눌러 주세요. 계속되면 처음 화면에서 다시 찾아 주세요.",
    };
  }
  if (err.status) {
    return {
      what: "정보를 불러오지 못했어요",
      why: `서버가 오류(HTTP ${err.status})로 답했어요.`,
      todo: "잠시 뒤 '다시 시도'를 눌러 주세요.",
    };
  }
  if (err instanceof SyntaxError) {
    return {
      what: "정보 파일을 읽을 수 없어요",
      why: "파일 내용이 깨져 있어요. 사이트를 새로 만드는 도중일 수 있어요.",
      todo: "잠시 뒤 '다시 시도'를 눌러 주세요.",
    };
  }
  return {
    what: "정보를 불러오지 못했어요",
    why: "인터넷 연결이 끊겼거나 서버가 잠시 응답하지 않아요.",
    todo: "연결을 확인하고 '다시 시도'를 눌러 주세요.",
  };
}

function showError(err) {
  console.error(err);
  const info = describeError(err);
  setStatus(`오류: ${info.what}`);
  render(
    "오류",
    problemBox({
      ...info,
      kind: "error",
      actions: [el("button", { type: "button", onclick: retry }, "다시 시도")],
    })
  );
  focusHeading();
}

// 다시 시도: sim=error 는 첫 시도만 실패시키므로, 두 번째부터는 정상으로 불러온다
// 누른 버튼이 사라지므로 다시 불러온 화면의 제목으로 초점을 옮긴다
async function retry() {
  if (sim === "error") {
    simErrorOn = false;
    const params = new URLSearchParams(location.search);
    params.delete("sim");
    const rest = params.toString();
    history.replaceState(null, "", rest ? `?${rest}` : "./");
    sim = null;
    updateSimBanner();
  }
  await route();
  focusHeading();
}

// ---------- 재현 모드 안내 띠 ----------

function updateSimBanner() {
  if (!sim) {
    simBanner.hidden = true;
    simBanner.replaceChildren();
    return;
  }
  const params = new URLSearchParams(location.search);
  params.delete("sim");
  const rest = params.toString();
  simBanner.replaceChildren(
    el("strong", {}, `재현 모드 (sim=${sim}) `),
    SIM_MODES[sim],
    " ",
    el("a", { href: rest ? `?${rest}` : "./" }, "재현 모드 끄기")
  );
  simBanner.hidden = false;
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
  const hasCompany = params.has("company");
  const hasQuery = params.has("q");
  const company = (params.get("company") || "").trim();
  const rawQuery = params.get("q") || "";
  clearFieldError();

  // 검색어 검사: 주소로 열었을 때도 검색 칸 아래에 같은 안내를 보여 준다
  let query = "";
  if (hasQuery) {
    const check = validateQuery(rawQuery);
    input.value = rawQuery;
    if (check.ok) {
      query = check.value;
      input.value = query;
    } else if (!hasCompany) {
      showFieldError(check);
      setStatus(`입력을 확인해 주세요: ${check.what}`);
      try {
        await showHome();
        setStatus(`입력을 확인해 주세요: ${check.what}`);
      } catch (err) {
        showError(err);
      }
      return;
    }
  }

  if (hasCompany && !/^\d{6}$/.test(company)) {
    invalidCompany(company);
    return;
  }

  showLoading(hasCompany ? "회사 정보를 불러오는 중이에요…" : "회사 목록을 불러오는 중이에요…");
  try {
    if (sim === "slow") await wait(SLOW_MS);
    if (simErrorOn) {
      await wait(600);
      const err = new Error("재현용 오류 (sim=error)");
      err.simulated = true;
      throw err;
    }
    if (hasCompany) await showCompany(company, query);
    else if (hasQuery) await showSearch(query);
    else await showHome();
  } catch (err) {
    showError(err);
  }
}

(function start() {
  const value = new URLSearchParams(location.search).get("sim");
  sim = Object.hasOwn(SIM_MODES, value || "") ? value : null;
  simErrorOn = sim === "error";
  updateSimBanner();
  fillFooter();
  route();
})();
