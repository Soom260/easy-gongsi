"""구글 시트(웹에 게시한 CSV)를 읽고 검사한다.

- 주소가 http로 시작하지 않으면 내 컴퓨터의 파일 경로로 보고 읽는다 (로컬 테스트용).
- 문제가 있으면 행 번호를 모아서 BuildError 로 한꺼번에 알린다.
- 시트 주소 전체는 로그에 찍지 않는다 (공개 저장소의 Actions 로그는 누구나 볼 수 있음).
"""
import csv
import io
import re
import urllib.error
import urllib.request
from pathlib import Path


class BuildError(Exception):
    """빌드를 멈춰야 하는 문제. 메시지는 '무슨 일 / 왜 / 할 일'을 담는다."""


# 탭별 필수 열 (1행 열 이름이 프로그램과의 약속)
DICT_COLUMNS = ["공시유형", "쉬운설명", "왜중요한지", "공개"]
TERMS_COLUMNS = ["용어", "쉬운설명", "읽는법", "공개"]
COMPANY_COLUMNS = ["종목코드", "표시이름", "업종", "공개"]


def fetch_text(source, tab_name):
    """게시 CSV 주소(또는 로컬 파일)에서 글자를 읽어 온다."""
    if not source:
        raise BuildError(
            f"[{tab_name}] 시트 주소가 비어 있어요.\n"
            f"  할 일: GitHub 저장소 Settings → Secrets and variables → Actions → Variables 에 주소를 넣어 주세요."
        )
    if not source.startswith(("http://", "https://")):
        path = Path(source)
        if not path.exists():
            raise BuildError(f"[{tab_name}] 파일을 찾을 수 없어요: {source}")
        return path.read_text(encoding="utf-8-sig")

    req = urllib.request.Request(source, headers={"User-Agent": "easy-gongsi-build"})
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
    except (urllib.error.URLError, TimeoutError) as e:
        raise BuildError(
            f"[{tab_name}] 시트를 내려받지 못했어요. (이유: {type(e).__name__})\n"
            f"  할 일: 주소가 맞는지, 시트가 '웹에 게시' 상태인지 확인해 주세요."
        )
    return raw.decode("utf-8-sig", errors="replace")


def parse_csv(text, tab_name, required_columns):
    """CSV 글자를 행 목록으로 바꾼다. 각 행에 시트 행 번호(_row)를 붙인다."""
    head = text.lstrip()[:200].lower()
    if head.startswith("<!doctype") or head.startswith("<html") or "<head" in head:
        raise BuildError(
            f"[{tab_name}] CSV 대신 웹페이지(HTML)가 왔어요.\n"
            f"  왜: 시트의 편집 주소나 공유 주소를 넣으면 이렇게 돼요.\n"
            f"  할 일: 파일 → 공유 → 웹에 게시 → 해당 탭 → 'CSV' 로 게시한 주소(output=csv)를 넣어 주세요."
        )

    reader = csv.DictReader(io.StringIO(text))
    columns = [c.strip() for c in (reader.fieldnames or [])]
    missing = [c for c in required_columns if c not in columns]
    if missing:
        raise BuildError(
            f"[{tab_name}] 1행에 필수 열이 없어요: {', '.join(missing)}\n"
            f"  지금 1행: {', '.join(columns) or '(비어 있음)'}\n"
            f"  할 일: 1행 열 이름을 샘플 CSV와 똑같이 맞춰 주세요."
        )

    rows = []
    for i, raw_row in enumerate(reader):
        row = {(k or "").strip(): (v or "").strip() for k, v in raw_row.items() if k is not None}
        row["_row"] = i + 2  # 1행은 열 이름이므로 데이터는 2행부터
        rows.append(row)
    return rows


def only_public(rows, tab_name):
    """공개 = Y 인 행만 남긴다. 하나도 없으면 멈춘다."""
    public = [r for r in rows if r.get("공개", "").upper() == "Y"]
    if not public:
        raise BuildError(
            f"[{tab_name}] '공개' 열이 Y 인 행이 하나도 없어요.\n"
            f"  할 일: 화면에 보여 줄 행의 '공개' 칸에 Y 를 적어 주세요."
        )
    return public


def stop_if_errors(errors, tab_name):
    if errors:
        lines = "\n".join(f"  - {e}" for e in errors)
        raise BuildError(f"[{tab_name}] 고쳐야 할 행이 {len(errors)}개 있어요.\n{lines}")


def load_companies(source):
    tab = "회사 목록 탭"
    rows = only_public(parse_csv(fetch_text(source, tab), tab, COMPANY_COLUMNS), tab)
    errors, seen = [], {}
    for r in rows:
        code, name = r["종목코드"], r["표시이름"]
        if re.fullmatch(r"\d{4,5}", code):
            errors.append(
                f"{r['_row']}행: 종목코드 '{code}' 가 6자리가 아니에요. "
                f"앞자리 0이 사라졌을 수 있어요 → 종목코드 열을 '서식 → 숫자 → 일반 텍스트'로 바꾸고 다시 적어 주세요."
            )
        elif not re.fullmatch(r"\d{6}", code):
            errors.append(f"{r['_row']}행: 종목코드 '{code}' 는 6자리 숫자가 아니에요. 예: 005930")
        elif code in seen:
            errors.append(f"{r['_row']}행: 종목코드 {code} 가 {seen[code]}행과 겹쳐요.")
        else:
            seen[code] = r["_row"]
        if not name:
            errors.append(f"{r['_row']}행: 표시이름이 비어 있어요.")
    stop_if_errors(errors, tab)
    return rows


def load_dict(source):
    tab = "쉬운말 사전 탭"
    rows = only_public(parse_csv(fetch_text(source, tab), tab, DICT_COLUMNS), tab)
    errors, seen = [], {}
    for r in rows:
        key = r["공시유형"].replace(" ", "")
        if not key:
            errors.append(f"{r['_row']}행: 공시유형이 비어 있어요.")
        elif key in seen:
            errors.append(f"{r['_row']}행: 공시유형 '{r['공시유형']}' 이 {seen[key]}행과 겹쳐요.")
        else:
            seen[key] = r["_row"]
        if not r["쉬운설명"]:
            errors.append(f"{r['_row']}행: 쉬운설명이 비어 있어요.")
    stop_if_errors(errors, tab)
    return rows
