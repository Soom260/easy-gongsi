"""정적 사이트를 만든다.

순서: 시트 읽기·검사 → 종목코드를 DART 고유번호로 변환 → 최근 공시 받기
     → 쉬운말 사전 매칭 → _site/data/*.json 쓰기

문제가 있으면 이유를 출력하고 실패 코드로 끝난다.
(워크플로에서 build 가 실패하면 deploy 가 실행되지 않아 이전 화면이 그대로 남는다)
"""
import json
import os
import re
import shutil
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dart import Dart
from sheets import BuildError, load_companies, load_dict

ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "site"
OUT_DIR = ROOT / "_site"
KST = timezone(timedelta(hours=9))
DISCLOSURE_DAYS = 90
DART_VIEWER = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo="


def load_dotenv():
    """내 컴퓨터 테스트용: .env 가 있으면 읽어서 환경 변수로 넣는다 (이미 있는 값은 그대로)."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def read_limit():
    """테스트용으로 다룰 회사 수를 줄인다. 비어 있거나 0이면 전체."""
    value = os.environ.get("LIMIT", "").strip() or "0"
    if not value.isdigit():
        raise BuildError(f"limit 값 '{value}' 는 0 이상의 숫자여야 해요.")
    return int(value)


def compact(text):
    return text.replace(" ", "")


def match_dict(report_nm, dict_rows):
    """공시 제목에 들어 있는 공시유형 키워드 중 가장 긴 것의 설명을 고른다."""
    title = compact(report_nm)
    hits = [r for r in dict_rows if compact(r["공시유형"]) in title]
    if not hits:
        return None
    best = max(hits, key=lambda r: len(compact(r["공시유형"])))
    return {"keyword": best["공시유형"], "easy": best["쉬운설명"], "why": best["왜중요한지"]}


def title_type(report_nm):
    """로그용: '[기재정정]주요사항보고서(유상증자결정)' → '주요사항보고서(유상증자결정)'"""
    return re.sub(r"^(\[[^\]]*\])+", "", report_nm).strip()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def build():
    now = datetime.now(KST)
    end_de = now.strftime("%Y%m%d")
    bgn_de = (now - timedelta(days=DISCLOSURE_DAYS)).strftime("%Y%m%d")

    # 1) 시트 읽기·검사
    print("[1/4] 구글 시트 읽기")
    companies = load_companies(os.environ.get("SHEET_COMPANIES_CSV_URL", ""))
    dict_rows = load_dict(os.environ.get("SHEET_DICT_CSV_URL", ""))
    print(f"  회사 {len(companies)}곳, 쉬운말 사전 {len(dict_rows)}개 (공개=Y 기준)")

    # 2) 종목코드 → 고유번호
    print("[2/4] DART 고유번호 받기")
    dart = Dart(os.environ.get("DART_API_KEY", "").strip())
    code_map = dart.corp_codes()
    print(f"  상장회사 고유번호 {len(code_map)}개 받음")
    unknown = [c for c in companies if c["종목코드"] not in code_map]
    if unknown:
        lines = "\n".join(
            f"  - {c['_row']}행: {c['종목코드']} ({c['표시이름']})" for c in unknown
        )
        raise BuildError(
            f"[회사 목록 탭] DART 고유번호로 바꿀 수 없는 종목코드가 있어요.\n{lines}\n"
            f"  왜: 종목코드를 잘못 적었거나 상장폐지된 회사일 수 있어요.\n"
            f"  할 일: 종목코드를 확인하거나 그 행의 '공개'를 N 으로 바꿔 주세요."
        )

    limit = read_limit()
    if limit:
        companies = companies[:limit]
        print(f"  (테스트) 앞에서 {limit}곳만 처리")

    # 3) 회사별 공시 받기 + 사전 매칭
    print(f"[3/4] 최근 {DISCLOSURE_DAYS}일 공시 받기 ({bgn_de}~{end_de})")
    index, unmatched = [], Counter()
    matched_count = total_items = 0
    for c in companies:
        stock = c["종목코드"]
        corp_code, official_name = code_map[stock]
        raw_items, total = dart.disclosures(corp_code, bgn_de, end_de)

        items = []
        for d in raw_items:
            report_nm = (d.get("report_nm") or "").strip()
            easy = match_dict(report_nm, dict_rows)
            if easy:
                matched_count += 1
            else:
                unmatched[title_type(report_nm)] += 1
            rcept_dt = d.get("rcept_dt", "")
            items.append({
                "title": report_nm,
                "date": f"{rcept_dt[:4]}-{rcept_dt[4:6]}-{rcept_dt[6:8]}" if len(rcept_dt) == 8 else rcept_dt,
                "filer": (d.get("flr_nm") or "").strip(),
                "rcept_no": d.get("rcept_no", ""),
                "url": DART_VIEWER + d.get("rcept_no", ""),
                "explain": easy,
            })
        total_items += len(items)

        write_json(OUT_DIR / "data" / "company" / f"{stock}.json", {
            "stock_code": stock,
            "name": c["표시이름"],
            "official_name": official_name,
            "sector": c["업종"],
            "corp_code": corp_code,
            "disclosures": {
                "from": f"{bgn_de[:4]}-{bgn_de[4:6]}-{bgn_de[6:]}",
                "to": f"{end_de[:4]}-{end_de[4:6]}-{end_de[6:]}",
                "total_count": total,
                "truncated": total > len(items),  # 100건이 넘으면 최신 100건만 담음
                "items": items,
            },
        })
        index.append({
            "stock_code": stock,
            "name": c["표시이름"],
            "official_name": official_name,
            "sector": c["업종"],
            "disclosure_count": total,
        })
        state = f"공시 {total}건" if total else "최근 공시 없음"
        print(f"  {stock} {c['표시이름']}: {state}")

    # 4) 목록과 기준 정보 쓰기
    print("[4/4] 파일 쓰기")
    write_json(OUT_DIR / "data" / "companies.json", index)
    write_json(OUT_DIR / "data" / "meta.json", {
        "generated_at": datetime.now(KST).isoformat(timespec="seconds"),
        "data_as_of": now.isoformat(timespec="seconds"),
        "disclosure_days": DISCLOSURE_DAYS,
        "company_count": len(index),
        "sources": [
            {
                "name": "금융감독원 OpenDART",
                "url": "https://opendart.fss.or.kr/",
                "terms_url": "https://opendart.fss.or.kr/intro/terms.do",
            },
            {"name": "쉬운말 설명: 직접 작성 (구글 시트)", "url": None, "terms_url": None},
        ],
    })

    rate = f"{matched_count / total_items:.0%}" if total_items else "-"
    print(f"  쉬운말 설명 매칭: {matched_count}/{total_items}건 ({rate})")
    if unmatched:
        print("  설명이 아직 없는 공시 제목 (많은 순, 사전에 추가할 후보):")
        for name, n in unmatched.most_common(10):
            print(f"    {n:>3}건  {name}")
    print(f"  DART 호출 {dart.calls}번")


def main():
    # 윈도우 터미널에서도 한글 로그가 깨지지 않게
    sys.stdout.reconfigure(encoding="utf-8")
    load_dotenv()

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    shutil.copytree(SITE_DIR, OUT_DIR)
    try:
        build()
    except BuildError as e:
        print(f"\n[중단] {e}\n\n잘못된 데이터는 배포하지 않아요. 이전에 배포한 화면이 그대로 남아요.")
        sys.exit(1)
    print(f"\n[완료] {OUT_DIR.name}/ 생성")


if __name__ == "__main__":
    main()
