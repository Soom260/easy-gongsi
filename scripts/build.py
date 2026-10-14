"""정적 사이트를 만든다.

1단계: site/ 를 _site/ 로 복사하고, 생성 시각을 data/meta.json 에 쓴다.
(DART와 구글 시트는 2단계에서 붙인다)
"""
import json
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE_DIR = ROOT / "site"
OUT_DIR = ROOT / "_site"
KST = timezone(timedelta(hours=9))


def main():
    # 윈도우 터미널에서도 한글 로그가 깨지지 않게
    sys.stdout.reconfigure(encoding="utf-8")

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    shutil.copytree(SITE_DIR, OUT_DIR)

    data_dir = OUT_DIR / "data"
    data_dir.mkdir()
    meta = {
        "generated_at": datetime.now(KST).isoformat(timespec="seconds"),
        "data_as_of": None,
        "sources": [
            {"name": "금융감독원 OpenDART", "url": "https://opendart.fss.or.kr/"},
            {"name": "쉬운말 설명: 직접 작성 (구글 시트)", "url": None},
        ],
    }
    (data_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[완료] {OUT_DIR.name}/ 생성, 생성 시각 {meta['generated_at']}")


if __name__ == "__main__":
    main()
