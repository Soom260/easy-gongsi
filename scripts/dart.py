"""OpenDART API 호출.

- 인증키는 환경 변수로만 받고, 로그·오류 메시지에서는 항상 가린다.
- 응답의 status 를 보고 '정상 / 데이터 없음 / 멈춰야 함'을 나눈다.
  공식 개발가이드: https://opendart.fss.or.kr/guide/main.do
"""
import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

from sheets import BuildError

BASE = "https://opendart.fss.or.kr/api"
PAUSE_SECONDS = 0.3  # 호출 사이 쉬는 시간
RETRIES = 3          # 네트워크 오류 때 다시 시도하는 횟수

OK = "000"
NO_DATA = "013"
# 이 코드들은 회사 하나의 문제가 아니라 전체 문제이므로 빌드를 멈춘다
FATAL_HINTS = {
    "010": "등록되지 않은 인증키예요. Secrets 의 DART_API_KEY 값을 확인해 주세요.",
    "011": "사용할 수 없는 인증키예요. OpenDART 에서 키 상태를 확인해 주세요.",
    "012": "접근할 수 없는 IP 예요. OpenDART 키 설정에 IP 제한이 있는지 확인해 주세요.",
    "014": "파일이 존재하지 않는대요. 잠시 뒤 다시 실행해 주세요.",
    "020": "오늘 요청 한도를 넘었어요. 내일 다시 실행하거나 limit 을 줄여 주세요.",
    "021": "조회 가능한 회사 수를 넘었어요.",
    "100": "요청 값이 잘못됐어요. 코드를 확인해야 해요.",
    "101": "부적절한 접근이래요.",
    "800": "OpenDART 가 점검 중이에요. 점검이 끝난 뒤 다시 실행해 주세요.",
    "900": "OpenDART 에서 알 수 없는 오류가 났어요. 잠시 뒤 다시 실행해 주세요.",
    "901": "개인정보 보유기간이 끝난 키예요. OpenDART 에서 키를 다시 확인해 주세요.",
}


class Dart:
    def __init__(self, api_key):
        if not api_key:
            raise BuildError(
                "DART 인증키가 없어요.\n"
                "  할 일: GitHub Secrets 에 DART_API_KEY 를 넣거나, 내 컴퓨터라면 .env 에 적어 주세요."
            )
        self._key = api_key
        self.calls = 0

    def _mask(self, text):
        """어떤 글자에서든 인증키를 *** 로 가린다."""
        return str(text).replace(self._key, "***")

    def _get(self, path, params):
        """요청을 보내고 응답 바이트를 돌려준다. 네트워크 오류는 몇 번 다시 시도한다."""
        query = urllib.parse.urlencode({"crtfc_key": self._key, **params})
        url = f"{BASE}/{path}?{query}"
        shown = self._mask(url)
        last_error = None
        for attempt in range(1, RETRIES + 1):
            time.sleep(PAUSE_SECONDS)
            self.calls += 1
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "easy-gongsi-build"})
                with urllib.request.urlopen(req, timeout=30) as res:
                    return res.read()
            except (urllib.error.URLError, TimeoutError) as e:
                last_error = self._mask(e)
                print(f"  [다시 시도 {attempt}/{RETRIES}] {shown} → {last_error}")
                time.sleep(2 * attempt)
        raise BuildError(
            f"OpenDART 에 연결하지 못했어요. ({RETRIES}번 시도)\n"
            f"  요청: {shown}\n  이유: {last_error}\n  할 일: 잠시 뒤 다시 실행해 주세요."
        )

    def _check_status(self, status, message, what):
        """status 가 정상이면 True, 데이터 없음이면 False, 그 밖은 멈춘다."""
        if status == OK:
            return True
        if status == NO_DATA:
            return False
        hint = FATAL_HINTS.get(status, "처음 보는 응답이에요. 개발가이드의 메시지 설명을 확인해야 해요.")
        raise BuildError(
            f"OpenDART 가 {what} 요청에 오류로 답했어요. (status {status}: {self._mask(message)})\n"
            f"  할 일: {hint}"
        )

    def _get_json(self, path, params, what):
        raw = self._get(path, params)
        try:
            data = json.loads(raw.decode("utf-8"))
        except ValueError:
            raise BuildError(f"OpenDART {what} 응답을 읽을 수 없어요. (JSON 이 아님)")
        has_data = self._check_status(data.get("status"), data.get("message", ""), what)
        return data if has_data else None

    def corp_codes(self):
        """고유번호 파일(zip 안 XML)을 받아 {종목코드: (고유번호, 정식이름)} 을 만든다."""
        raw = self._get("corpCode.xml", {})
        if not raw.startswith(b"PK"):
            # 키가 틀리면 zip 대신 <result><status>..</status></result> XML 이 온다 (HTTP 200)
            try:
                root = ET.fromstring(raw)
                status, message = root.findtext("status", ""), root.findtext("message", "")
            except ET.ParseError:
                status, message = "", "zip 도 XML 도 아닌 응답"
            self._check_status(status, message, "고유번호")
            raise BuildError("OpenDART 고유번호 파일이 zip 이 아니에요. 잠시 뒤 다시 실행해 주세요.")

        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            root = ET.fromstring(z.read(z.namelist()[0]))

        result = {}
        for item in root.iter("list"):
            stock = (item.findtext("stock_code") or "").strip()
            if not stock:
                continue  # 비상장 회사는 종목코드가 없음
            modify = item.findtext("modify_date") or ""
            # 같은 종목코드가 두 번 나오면 최근에 바뀐 쪽을 쓴다
            if stock in result and result[stock][2] >= modify:
                continue
            result[stock] = (item.findtext("corp_code"), (item.findtext("corp_name") or "").strip(), modify)
        return {k: (v[0], v[1]) for k, v in result.items()}

    def disclosures(self, corp_code, bgn_de, end_de):
        """회사 하나의 기간 내 공시 목록 (최종보고서만, 최신순, 최대 100건).

        데이터가 없으면 빈 목록과 total_count 0 을 돌려준다.
        """
        data = self._get_json(
            "list.json",
            {
                "corp_code": corp_code,
                "bgn_de": bgn_de,
                "end_de": end_de,
                "last_reprt_at": "Y",
                "sort": "date",
                "sort_mth": "desc",
                "page_no": 1,
                "page_count": 100,
            },
            "공시검색",
        )
        if data is None:
            return [], 0
        return data.get("list", []), int(data.get("total_count", 0))
