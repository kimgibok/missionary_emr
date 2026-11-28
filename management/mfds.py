"""
식약처 의약품 제품 허가정보 API (공공데이터포털 data.go.kr) - 관리자 [약품] 모달의 [약 정보 찾기].

이 EMR에서 유일하게 인터넷이 필요한 기능이다. 출발 전 준비할 때(인터넷 되는 곳)만 쓰고, 현장 업무에는 쓰지 않는다.
인터넷이 없거나 키가 없으면 MfdsError(사람이 읽을 한국어 메시지)를 낸다 - 다른 기능에는 영향 없음.

- 키: settings.MFDS_API_KEY (config/local_settings.py, git 제외). Encoding 키든 Decoding 키든 된다(먼저 디코딩).
  키는 서버에서만 쓰고 브라우저로 보내지 않는다.
- 주소: https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService08 (2026-11 확인, 버전이 바뀌면 BASE·OP_*만 고친다)
  목록 getDrugPrdtPrmsnInq08(item_name 검색) / 상세 getDrugPrdtPrmsnDtlInq08(item_seq)
- 효능효과(EE_DOC_DATA)·용법용량(UD_DOC_DATA)은 XML 문서로 온다 → doc_text()로 글자만 뽑는다.
"""
import html
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from django.conf import settings

BASE = 'https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService08'
OP_LIST = 'getDrugPrdtPrmsnInq08'
OP_DETAIL = 'getDrugPrdtPrmsnDtlInq08'
TIMEOUT = 10        # 초 - 인터넷이 느리거나 없을 때 오래 붙잡지 않게
USAGE_MAX = 200     # Drug.usage 길이

# 분량 단위 (MATERIAL_NAME의 한글 단위 → 약품 성분 칸에 쓰는 기호)
UNIT_SYMBOLS = {
    '밀리그램': 'mg', '그램': 'g', '마이크로그램': 'μg', '밀리리터': 'mL', '리터': 'L',
    '국제단위': 'IU', '단위': 'unit', '퍼센트': '%', '%': '%',
}

NOT_SET = '식약처 API 인증키가 설정되지 않았습니다. config/local_settings.py의 MFDS_API_KEY를 채워 주세요.'
OFFLINE = '인터넷에 연결되지 않아 약 정보를 찾을 수 없습니다. 인터넷이 되는 곳에서 해 주세요 (준비할 때만 쓰는 기능).'


class MfdsError(Exception):
    """사람이 읽을 메시지를 담은 오류 - status는 API 응답 코드(뷰가 그대로 쓴다)"""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def api_key():
    return urllib.parse.unquote((getattr(settings, 'MFDS_API_KEY', '') or '').strip())


def is_enabled():
    return bool(api_key())


def call(op, **params):
    """API 한 번 부르기 → items 목록. 키가 없거나 인터넷이 없거나 API가 오류를 주면 MfdsError"""
    key = api_key()
    if not key:
        raise MfdsError(NOT_SET, status=503)
    query = urllib.parse.urlencode({'serviceKey': key, 'type': 'json', 'pageNo': 1, **params})
    request = urllib.request.Request(f'{BASE}/{op}?{query}', headers={'User-Agent': 'missionary-emr'})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            text = response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as err:
        body = err.read().decode('utf-8', 'replace')
        if 'SERVICE_KEY_IS_NOT_REGISTERED' in body:
            raise MfdsError('식약처 API가 인증키를 모른다고 합니다. 활용 신청 직후면 1시간쯤 뒤에 다시 해 주세요.')
        raise MfdsError(f'식약처 API 오류입니다. ({err.code}) 잠시 후 다시 해 주세요.')
    except (urllib.error.URLError, TimeoutError, OSError):
        raise MfdsError(OFFLINE, status=503)

    try:
        data = json.loads(text)
    except ValueError:
        raise MfdsError('식약처 API 응답을 읽을 수 없습니다. 잠시 후 다시 해 주세요.')
    header = data.get('header') or {}
    if header.get('resultCode') not in (None, '00'):
        raise MfdsError(f'식약처 API 오류입니다: {header.get("resultMsg") or header.get("resultCode")}')
    items = (data.get('body') or {}).get('items') or []
    if isinstance(items, dict):     # 한 건이면 dict로 올 때가 있다
        items = items.get('item') or [items]
    return items if isinstance(items, list) else []


# =====================================================
# 글자 정리
# =====================================================

def value(item, key):
    """API의 빈 값은 'None' 글자로 온다"""
    v = item.get(key)
    return '' if v in (None, 'None') else str(v).strip()


def short_name(name):
    """'세라진정(세티리진염산염)[수출명: …]' → '세라진정' (약품명 칸에 넣기 좋게)"""
    name = re.sub(r'\[\s*수출명[^\]]*\]', '', name)
    name = re.sub(r'\(\s*수출명[^)]*\)', '', name)
    name = re.sub(r'\([^()]*\)\s*$', '', name.strip())
    return name.strip() or name


def doc_text(xml):
    """효능효과·용법용량 XML → 글자. 조항 제목과 문단을 줄 단위로, 표는 칸을 공백·줄로 이어 붙인다"""
    if not xml or xml == 'None':
        return ''
    lines = []
    for title, cdata in re.findall(r'<ARTICLE title="([^"]*)"|<!\[CDATA\[(.*?)\]\]>', xml, re.S):
        piece = title or cdata
        piece = re.sub(r'</(tr|p|div|li)>|<br\s*/?>', '\n', piece, flags=re.I)
        piece = re.sub(r'<[^>]+>', ' ', piece)
        piece = html.unescape(piece)
        for line in piece.split('\n'):
            line = re.sub(r'[ \t 　]+', ' ', line).strip()
            if line:
                lines.append(line)
    return '\n'.join(lines)


def material_entries(detail):
    """
    원료 분량(MATERIAL_NAME) → [(한글 성분명, 분량 글자)]. 항목은 ';', 칸은 '|', 이름·값은 ':'로 나뉜다.
    분량은 '성분정보'에 '~(으)로서 60 밀리그램'(실제 함량 표기)이 있으면 그것을, 없으면 '분량'+'단위'를 쓴다.
    (예: 록소프로펜나트륨수화물 68.1mg → 무수물로서 60mg)
    """
    entries = []
    for entry in value(detail, 'MATERIAL_NAME').split(';'):
        fields = dict(
            (k.strip(), v.strip()) for k, v in (part.split(':', 1) for part in entry.split('|') if ':' in part)
        )
        if not fields.get('성분명'):
            continue
        match = re.search(r'로서\s*([\d.]+)\s*([가-힣%]+)', fields.get('성분정보', ''))
        number, unit = (match.group(1), match.group(2)) if match else (fields.get('분량', ''), fields.get('단위', ''))
        if number:
            number = number.rstrip('0').rstrip('.') if '.' in number else number
            amount = f'{number}{UNIT_SYMBOLS.get(unit, unit)}'
        else:
            amount = ''
        entries.append((fields['성분명'], amount))
    return entries


def ingredient_text(detail):
    """
    성분 칸 글자 - 영어로만 (지금 약품 데이터와 같은 모양). (글자, 안내) 를 돌려준다.
    - 성분 하나: 영문 주성분 + 분량 ('Cetirizine Hydrochloride 10mg')
    - 성분 여럿(복합제): 영문 이름만 ('Acetaminophen, Tramadol Hydrochloride') - 분량은 사람이 적는다.
      식약처가 영문 목록(MAIN_INGR_ENG)과 분량 목록(MATERIAL_NAME)을 서로 다른 순서로 주기 때문에
      영문에 분량을 붙이면 뒤바뀔 수 있다(시너젯정: 아세트아미노펜 325mg + 트라마돌 37.5mg). 한글 원료+분량은 material_text()로 보여준다.
    - 영문이 없으면 한글 원료+분량 (드물다)
    """
    english = [n.strip() for n in value(detail, 'MAIN_INGR_ENG').split('/') if n.strip()]
    entries = material_entries(detail)
    if len(english) == 1:
        amount = entries[0][1] if len(entries) == 1 else ''
        return f'{english[0]} {amount}'.strip()[:200], ''
    if english:
        return ', '.join(english)[:200], '복합제라 분량은 직접 적어 주세요.'
    return material_text(detail)[:200], '식약처에 영문 성분이 없어 한글로 넣습니다.'


def material_text(detail):
    """한글 원료 + 분량 ('트라마돌염산염 37.5mg, 아세트아미노펜 325mg') - 같은 원료 항목끼리라 짝이 정확하다"""
    return ', '.join(f'{name} {amount}'.strip() for name, amount in material_entries(detail))


def ingredient_codes(detail):
    """'[M222857]세티리진염산염|[M040624]…' → ['M222857', …]"""
    return re.findall(r'\[(M\d+)\]', value(detail, 'MAIN_ITEM_INGR'))


def product_type_name(item):
    """'[01410]항히스타민제' → '항히스타민제'"""
    return re.sub(r'^\[[^\]]*\]\s*', '', value(item, 'PRDUCT_TYPE'))


# =====================================================
# 화면용
# =====================================================

def search(query, limit=20):
    """품목명으로 찾기 → [{item_seq, name, short_name, company, kind, product_type, ingredient, canceled}]"""
    items = call(OP_LIST, item_name=query, numOfRows=limit)
    return [
        {
            'item_seq': value(i, 'ITEM_SEQ'),
            'name': value(i, 'ITEM_NAME'),
            'short_name': short_name(value(i, 'ITEM_NAME')),
            'company': value(i, 'ENTP_NAME'),
            'kind': value(i, 'SPCLTY_PBLC'),            # 전문의약품 / 일반의약품
            'product_type': product_type_name(i),       # 식약처 분류 (예: 항히스타민제)
            'ingredient': value(i, 'ITEM_INGR_NAME'),   # 영문 주성분
            'canceled': value(i, 'CANCEL_NAME') not in ('', '정상'),
        }
        for i in items
    ]


def detail(item_seq):
    """품목 하나의 상세 → 약품 칸에 넣을 값 + 참고 정보 (MfdsError: 없는 품목 등)"""
    items = call(OP_DETAIL, item_seq=item_seq, numOfRows=1)
    if not items:
        raise MfdsError('식약처에서 이 품목을 찾지 못했습니다.', status=404)
    d = items[0]
    ingredient, ingredient_note = ingredient_text(d)
    usage_full = doc_text(value(d, 'UD_DOC_DATA'))
    usage_one_line = re.sub(r'\s*\n\s*', ' ', usage_full)
    return {
        'item_seq': value(d, 'ITEM_SEQ'),
        'name': value(d, 'ITEM_NAME'),
        'short_name': short_name(value(d, 'ITEM_NAME')),
        'company': value(d, 'ENTP_NAME'),
        'kind': value(d, 'ETC_OTC_CODE'),
        'ingredient': ingredient,
        'ingredient_note': ingredient_note,          # 복합제 등 - 화면에 안내
        'material_kr': material_text(d),             # 한글 원료 + 분량 (복합제 분량을 적을 때 참고)
        'ingredient_codes': ingredient_codes(d),
        'main_ingredient_kr': re.sub(r'\[M\d+\]', '', value(d, 'MAIN_ITEM_INGR')).replace('|', ', '),
        'usage': usage_one_line[:USAGE_MAX],
        'usage_truncated': len(usage_one_line) > USAGE_MAX,
        'usage_full': usage_full,
        'efficacy': doc_text(value(d, 'EE_DOC_DATA')),
        'pack_unit': value(d, 'PACK_UNIT'),
        'storage': value(d, 'STORAGE_METHOD'),
        'valid_term': value(d, 'VALID_TERM'),
        'chart': value(d, 'CHART'),
    }
