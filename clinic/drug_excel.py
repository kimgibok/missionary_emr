"""
약품 엑셀 가져오기·내보내기 - 관리자 화면(API)과 관리 커맨드(import_drugs)가 같이 쓴다.

가져오기 양식 두 가지 (자동으로 알아본다)
1) 표준 양식 - 이 모듈의 export_workbook()이 만드는 파일. 첫 줄 머리에 '세부 분류'와 '약품명'이 있다.
   분류 = 시트 이름. '약속처방 - OS'처럼 ' - '가 있는 분류는 앞부분('약속처방')으로 한 시트에 묶고, 그 시트에만 '분류' 열이 있다.
   한 줄 = 배치 하나 (입고량·배치 번호가 비면 약품 정보만). 배치 번호 열은 숨겨 둔다(다시 올릴 때 기존 배치를 알아보는 데 쓴다).
   - 배치 번호가 있는 줄 = 이미 있는 배치. 임시 유통기한(2099-12-31)인데 엑셀에 날짜가 있으면 유통기한만 채운다.
     입고량·잔량·출처 등이 DB와 다르면 고치지 않고 '다름'으로 알려 준다(재고 숫자는 관리자 [잔량 보정]으로만).
   - 배치 번호가 없는 줄 = 새 입고. 같은 배치(약품·출처·유통기한·포장 단위·입고량)가 이미 있으면 건너뛴다.
     같은 약품·출처·포장·입고량의 임시 유통기한 배치가 있고 엑셀에 날짜가 있으면 그 배치의 유통기한만 채운다.
2) 옛 '약품 리스트' 양식 - 시트 이름 '2026-경구' 등, 시트마다 열이 다르다(SHEET_LAYOUTS), 4행부터.

공통 규칙
- 분류·세부 분류 이름은 띄어쓰기를 무시하고 비교해 이미 있는 이름을 쓴다. 없으면 새로 만든다.
- 같은 분류 안에서 약품명이 같으면 한 약품. 이미 있는 약품은 비어 있는 성분·용법만 채운다.
- 오류(날짜·숫자 형식, 없는 배치 번호 등)가 하나라도 있으면 아무것도 넣지 않는다.
- 미리보기도 실제와 같은 코드로 넣어 본 뒤 되돌린다(transaction rollback).
- 미션 배분(MissionStock)은 만들지 않는다.
"""
import datetime
import re
from collections import Counter
from io import BytesIO

from django.db import transaction
from django.utils import timezone
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill

from .models import Drug, DrugBatch, DrugCategory1, DrugCategory2

PLACEHOLDER_EXPIRY = datetime.date(2099, 12, 31)    # 유통기한 미확인 표시용 임시 날짜

# 분류 이름 맞추기 (엑셀 이름 → DB 이름)
CAT1_ALIASES = {'외용약': '외용'}
CAT2_ALIASES = {'정맥순한개선제': '정맥순환개선제'}   # 엑셀 오타

# 분류마다 처방할 때 복용스케줄(1회량·횟수·일수)로 입력할지 (새로 만드는 분류와 옛 양식 가져오기에서 맞춘다)
# 소아는 시럽이라 재고 단위가 '병'이다 - 스케줄로 계산하면 ml 수(예: 45)가 나와 재고와 안 맞으므로 병 수를 직접 입력한다
USES_SCHEDULE = {'경구': True, '비타민': True, '소아': False, '외용': False, '주사제': False, '추가약': False}

# 옛 '약품 리스트' 양식 - 시트 종류별 열 위치 (0부터). 데이터는 4행부터, 'No.'가 숫자인 줄만 읽는다.
#   per: 포장 단위 수량(경구·비타민) 또는 포장 글자(외용·주사·소아), boxes: 통 수, total: 총수량, expiry: 유통기한, usage: 용법
SHEET_LAYOUTS = {
    '경구': {'per': 4, 'boxes': 5, 'total': 6, 'usage': 8, 'kind': 'count'},
    '비타민': {'per': 4, 'boxes': 5, 'total': 6, 'kind': 'count'},
    '외용약': {'per': 4, 'total': 5, 'expiry': 7, 'kind': 'pack'},
    '주사제': {'per': 4, 'total': 5, 'expiry': 7, 'kind': 'pack'},
    '추가약': {'per': 4, 'total': 5, 'kind': 'pack'},
    '소아': {'per': 5, 'boxes': 6, 'total': 7, 'kind': 'bottle'},
}
PROMISE_SHEET = '약속처방'

# 표준 양식 열 (순서 = 엑셀 열 순서). '분류' 열은 여러 분류를 묶은 시트(약속처방)에만 맨 앞에 붙는다.
CAT1_COLUMN = ('cat1', '분류')
STANDARD_COLUMNS = [
    ('cat2', '세부 분류'), ('name', '약품명'), ('ingredient', '성분'), ('usage', '용법'),
    ('unit_qty', '포장 단위 수량'), ('unit_label', '단위'), ('remaining', '창고 잔량'), ('total', '입고량'),
    ('expiry', '유통기한'), ('received', '입고일'), ('source', '출처'), ('source_detail', '출처 상세'),
    ('batch_id', '배치 번호'),     # 숨긴 열
]
COLUMN_WIDTHS = {
    '분류': 16, '세부 분류': 16, '약품명': 26, '성분': 36, '용법': 36, '포장 단위 수량': 14, '단위': 10,
    '창고 잔량': 10, '입고량': 10, '유통기한': 12, '입고일': 12, '출처': 10, '출처 상세': 14, '배치 번호': 10,
}
SOURCE_BY_LABEL = {label: code for code, label in DrugBatch.Source.choices}
INVALID_SHEET_CHARS = re.compile(r'[\\/?*\[\]:]')   # 엑셀 시트 이름에 못 쓰는 글자

HOW_TO = [
    '약품 엑셀 사용법',
    '',
    '- 분류마다 시트가 하나씩 있습니다(시트 이름 = 분류). 약속처방은 세트들을 한 시트에 모았고, 그 시트에만 [분류] 칸이 있습니다.',
    '- 한 줄 = 창고 배치 하나입니다. 배치가 없는 약은 약 정보만 한 줄 들어 있습니다.',
    '- 새로 입고한 약은 그 분류 시트 맨 아래에 줄을 추가하세요. 세부 분류·약품명·포장 단위 수량·단위·입고량을 적습니다.',
    '- 새 분류를 만들려면 시트를 하나 추가하고 시트 이름을 분류 이름으로 바꾸세요. 첫 줄 머리글은 다른 시트에서 복사하세요.',
    '- [유통기한]이 빈 칸인 배치는 날짜를 모르는 약(미확인)입니다. 날짜를 적어서 올리면 유통기한만 채워집니다.',
    '- 원래 있던 줄의 입고량·창고 잔량·출처는 올려도 바뀌지 않습니다. 재고 숫자는 관리자 화면 [창고 재고] → [잔량 보정]으로 고치세요.',
    '- 숨긴 열(배치 번호)은 기존 배치를 알아보는 데 씁니다. 지우거나 고치지 마세요.',
    '- 이미 있는 약품은 비어 있는 성분·용법만 채워집니다. 고쳐 둔 내용은 덮어쓰지 않습니다.',
    '- 날짜는 2028-10-29 또는 2028.10.29처럼 적습니다. 출처는 후원·현지·구매·현지구매·기타 중 하나입니다.',
    '- 올리면 먼저 미리보기가 나옵니다. 오류가 하나라도 있으면 아무것도 들어가지 않습니다.',
]


# =====================================================
# 글자·숫자·날짜 정리
# =====================================================

def clean(value):
    """셀 글자 정리 - 특수 공백(\\xa0, 전각 공백 등)을 보통 공백으로, 공백 여러 개는 하나로"""
    if value is None:
        return ''
    text = str(value).replace('‑', '-')
    text = re.sub(r'[\s 　 ]+', ' ', text)
    return text.strip()


def name_key(name):
    """이름 비교용 - 띄어쓰기를 무시한다 ('해열,진통,소염제' = '해열, 진통, 소염제')"""
    return re.sub(r'\s+', '', name)


def to_int(value):
    """'3000포', 1000, 2.0 → 정수 / 비었거나 숫자가 없으면 None"""
    if value is None or value == '':
        return None
    if isinstance(value, (int, float)):
        return int(value)
    match = re.search(r'\d+', str(value).replace(',', ''))
    return int(match.group()) if match else None


def to_date(value):
    """'2028.10.29' 또는 엑셀 날짜 → date / 비었으면 None / 모르는 형식이면 ValueError"""
    if value in (None, ''):
        return None
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    match = re.fullmatch(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\.?', clean(value))
    if not match:
        raise ValueError(f'날짜 형식을 모르겠습니다: {value} (예: 2028-10-29)')
    try:
        return datetime.date(*map(int, match.groups()))
    except ValueError:
        raise ValueError(f'없는 날짜입니다: {value}')


def guess_unit(name, usage):
    """경구약 낱개 단위 추정 - 옛 양식에 없어서 용법·이름으로 짐작한다 (관리자 화면에서 고칠 수 있다)"""
    if re.search(r'\d\s*포', usage):
        return '포'
    if '캡슐' in name or '캡슐' in usage:
        return '캡슐'
    if '패취' in name or '패치' in name:
        return '매'
    return '정'


def cat_group(name):
    """시트 묶음 이름 - '약속처방 - OS'처럼 ' - '가 있으면 앞부분('약속처방'), 없으면 그대로 (관리자 재고 화면의 분류 칩과 같은 규칙)"""
    return name.split(' - ')[0].strip()


def sheet_title(name, taken):
    """엑셀 시트 이름 - 못 쓰는 글자 빼고 31자, 겹치면 뒤에 번호"""
    base = INVALID_SHEET_CHARS.sub('·', name)[:28] or '분류'
    title, n = base, 2
    while title in taken:
        title, n = f'{base}_{n}', n + 1
    taken.add(title)
    return title


# =====================================================
# 내보내기 (표준 양식)
# =====================================================

def export_workbook():
    """
    약품 전체 + 창고 배치 → 표준 양식 엑셀 bytes.
    분류 = 시트(묶음 분류는 한 시트 + '분류' 열), 한 줄 = 배치 (배치 없는 약은 약 정보만), 배치 번호 열은 숨긴다.
    """
    wb = Workbook()
    guide = wb.active
    guide.title = '사용법'
    for line in HOW_TO:
        guide.append([line])
    guide['A1'].font = Font(bold=True, size=14)
    guide.column_dimensions['A'].width = 120

    head_font = Font(bold=True)
    head_fill = PatternFill('solid', fgColor='E8EEF3')
    labels = dict(DrugBatch.Source.choices)
    taken = {'사용법'}

    drugs = list(
        Drug.objects.select_related('cat1', 'cat2').prefetch_related('batches').order_by('cat1__name', 'cat2__name', 'name')
    )
    groups = {}     # 묶음 이름 → 그 묶음의 분류 이름들
    for drug in drugs:
        groups.setdefault(cat_group(drug.cat1.name), set()).add(drug.cat1.name)

    sheets = {}     # 묶음 이름 → (시트, 열 목록)
    for group in sorted(groups):
        # 분류가 여러 개거나 분류 이름이 묶음 이름과 다르면(약속처방 - OS) 줄마다 분류를 적는다
        needs_cat1 = len(groups[group]) > 1 or next(iter(groups[group])) != group
        columns = ([CAT1_COLUMN] if needs_cat1 else []) + STANDARD_COLUMNS
        ws = wb.create_sheet(sheet_title(group, taken))
        ws.append([label for _, label in columns])
        for cell in ws[1]:
            cell.font, cell.fill = head_font, head_fill
            ws.column_dimensions[cell.column_letter].width = COLUMN_WIDTHS.get(cell.value, 12)
            if cell.value == '배치 번호':
                ws.column_dimensions[cell.column_letter].hidden = True
        ws.freeze_panes = 'B2' if needs_cat1 else 'A2'
        sheets[group] = (ws, columns)

    for drug in drugs:
        ws, columns = sheets[cat_group(drug.cat1.name)]
        info = {'cat1': drug.cat1.name, 'cat2': drug.cat2.name, 'name': drug.name,
                'ingredient': drug.ingredient, 'usage': drug.usage}
        batches = sorted(drug.batches.all(), key=lambda b: (b.expiry_date, b.id))
        if not batches:
            ws.append([info.get(key) for key, _ in columns])
            continue
        for b in batches:
            values = dict(info, **{
                'unit_qty': b.unit_qty, 'unit_label': b.unit_label, 'remaining': b.remaining_qty, 'total': b.total_qty,
                'expiry': None if b.expiry_date == PLACEHOLDER_EXPIRY else b.expiry_date,
                'received': b.received_date, 'source': labels.get(b.source, b.source),
                'source_detail': b.source_detail, 'batch_id': b.id,
            })
            ws.append([values.get(key) for key, _ in columns])

    for ws, columns in sheets.values():
        date_cols = [i for i, (key, _) in enumerate(columns) if key in ('expiry', 'received')]
        for row in ws.iter_rows(min_row=2):
            for i in date_cols:     # 유통기한·입고일 칸 날짜 모양
                row[i].number_format = 'yyyy-mm-dd'

    buffer = BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


# =====================================================
# 가져오기
# =====================================================

class DrugImporter:
    """
    importer = DrugImporter(source='donation', received=date)
    result = importer.run(file, commit=False)   # 미리보기
    result = {'committed', 'summary': [[이름, 건수], ...], 'lines': [...], 'errors': [...], 'format'}
    source·received는 옛 양식과, 표준 양식에서 출처·입고일 칸이 빈 새 배치에 쓴다.
    """

    def __init__(self, source='donation', received=None):
        self.source = source
        self.received = received or timezone.localdate()
        self.report = Counter()     # 종류별 건수 (요약)
        self.lines = []             # 줄마다 한 일 (미리보기 목록)
        self.errors = []            # 하나라도 있으면 아무것도 넣지 않는다
        self.seen = Counter()       # 이번 엑셀에서 같은 배치가 몇 번째로 나왔는지
        self.format = None

    # ----- 진입점 -----

    def run(self, file, commit=False):
        try:
            wb = load_workbook(file, read_only=True, data_only=True)
        except Exception:
            self.errors.append('엑셀 파일(.xlsx)을 열 수 없습니다. 파일을 확인해 주세요.')
            return self.result(False)

        rows = self.read_workbook(wb)
        if not rows:
            if not self.errors:
                self.errors.append('가져올 약이 없습니다. 표준 양식(관리자 [엑셀 내려받기])이나 약품 리스트 양식인지 확인해 주세요.')
            return self.result(False)

        # 읽기에서 오류가 있어도 나머지 줄은 넣어 보고(되돌림) 넣기 단계의 오류(없는 배치 번호 등)까지 한꺼번에 알려 준다
        with transaction.atomic():
            for row in rows:
                self.import_row(row)
            if self.format == 'legacy':
                self.fix_schedule_flags()
            if self.errors or not commit:
                transaction.set_rollback(True)   # 미리보기거나 오류가 있으면 넣어 본 것을 되돌린다
        return self.result(commit and not self.errors)

    def result(self, committed):
        return {
            'committed': committed,
            'format': self.format,
            'summary': [[k, v] for k, v in self.report.items()],
            'lines': self.lines,
            'errors': self.errors,
        }

    # ----- 엑셀 읽기 → 줄 목록 -----

    def read_workbook(self, wb):
        standard = [ws for ws in wb.worksheets if self.is_standard_sheet(ws)]
        if standard:
            self.format = 'standard'
            rows = []
            for ws in standard:
                rows += self.read_standard_sheet(ws)
            return rows

        self.format = 'legacy'
        rows = []
        for ws in wb.worksheets:
            kind = ws.title.split('-', 1)[-1].strip()
            if kind == PROMISE_SHEET:
                rows += self.read_promise_sheet(ws)
            elif kind in SHEET_LAYOUTS:
                rows += self.read_legacy_sheet(ws, kind)
            elif ws.title != '사용법':
                self.lines.append(f'! [{ws.title}] 모르는 시트라 건너뜀')
        return rows

    @staticmethod
    def is_standard_sheet(ws):
        head = next(ws.iter_rows(min_row=1, max_row=1, values_only=True), ())
        names = [clean(c) for c in head]
        return '약품명' in names and '세부 분류' in names

    @staticmethod
    def sheet_cat1(title):
        """
        시트 이름 → 분류 이름. 내보낼 때 바뀐 글자('/'→'·')·띄어쓰기는 무시하고 기존 분류를 찾는다.
        여러 분류를 묶은 시트(약속처방)면 None - 줄마다 [분류] 칸을 봐야 한다. 없는 이름이면 새 분류(시트 이름 그대로).
        """
        key = name_key(title)
        names = list(DrugCategory1.objects.values_list('name', flat=True))
        for name in names:
            if key in (name_key(name), name_key(INVALID_SHEET_CHARS.sub('·', name)[:28])):
                return name
        grouped = [name for name in names if name_key(cat_group(name)) == key]
        if len(grouped) == 1:
            return grouped[0]
        if grouped:
            return None
        return CAT1_ALIASES.get(clean(title), clean(title))

    def read_standard_sheet(self, ws):
        head = [clean(c) for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))]
        # 열 위치는 머리줄 글자로 찾는다 (사용자가 열 순서를 바꾸거나 열을 지워도 읽히게)
        col = {key: (head.index(label) if label in head else None) for key, label in [CAT1_COLUMN] + STANDARD_COLUMNS}
        sheet_cat1 = self.sheet_cat1(ws.title)
        rows = []
        for excel_row, r in enumerate(ws.iter_rows(min_row=2, values_only=True), 2):
            def cell(key, r=r):
                i = col[key]
                return r[i] if i is not None and i < len(r) else None

            if all(c in (None, '') for c in r):
                continue
            where = f'[{ws.title}] {excel_row}행'
            row = {'where': where}
            for key in ('cat1', 'cat2', 'name', 'ingredient', 'usage', 'source_detail', 'unit_label'):
                row[key] = clean(cell(key))
            row['cat1'] = row['cat1'] or sheet_cat1     # 분류 칸이 있으면 그 값, 없으면 시트 이름
            if not row['cat1']:
                self.errors.append(f'{where}: 여러 분류를 묶은 시트라 [분류] 칸을 적어야 합니다. (예: 약속처방 - OS)')
                continue
            if not (row['cat2'] and row['name']):
                self.errors.append(f'{where}: 세부 분류·약품명은 꼭 적어야 합니다.')
                continue

            # 한 줄의 문제를 한꺼번에 모은다 (하나 고치고 올리면 또 다른 오류가 나오지 않게)
            problems = []
            source_label = clean(cell('source'))
            if source_label and source_label not in SOURCE_BY_LABEL:
                problems.append(f'출처 "{source_label}"을(를) 모르겠습니다. ({"·".join(SOURCE_BY_LABEL)} 중 하나)')
            row['source'] = SOURCE_BY_LABEL.get(source_label)
            for key, label in (('received', '입고일'), ('expiry', '유통기한')):
                try:
                    row[key] = to_date(cell(key))
                except ValueError as err:
                    problems.append(f'{label} - {err}')
            if problems:
                self.errors.extend(f'{where}: {p}' for p in problems)
                continue
            row['unit_qty'] = to_int(cell('unit_qty'))
            row['total'] = to_int(cell('total'))
            row['remaining'] = to_int(cell('remaining'))
            row['batch_id'] = to_int(cell('batch_id'))
            row['standard'] = True
            rows.append(row)
        return rows

    def read_legacy_sheet(self, ws, kind):
        layout = SHEET_LAYOUTS[kind]
        rows = []
        for excel_row, r in enumerate(ws.iter_rows(min_row=4, values_only=True), 4):
            cell = lambda i: r[i] if i is not None and i < len(r) else None  # noqa: E731
            if not isinstance(cell(0), (int, float)) or not clean(cell(2)):
                continue    # 머리줄('No.')·빈 줄
            where = f'[{ws.title}] {excel_row}행'
            name = clean(cell(2))
            usage = clean(cell(layout.get('usage')))
            per = cell(layout['per'])

            if layout['kind'] == 'count':      # 경구·비타민: 1통당 낱개 수 × 통 수 = 총수량(낱개)
                unit_qty = to_int(per) or 1
                total = to_int(cell(layout['total'])) or (unit_qty * (to_int(cell(layout['boxes'])) or 0)) or None
                unit_label = guess_unit(name, usage)
            elif layout['kind'] == 'pack':     # 외용·주사: 총량 = 통·바이알 개수
                unit_qty, total = 1, to_int(cell(layout['total']))
                unit_label = f'개({clean(per)})' if clean(per) else '개'
            else:                              # 소아 시럽: 수량이 비어 있으면 1병
                unit_qty = 1
                total = to_int(cell(layout['total'])) or to_int(cell(layout['boxes'])) or 1
                unit_label = f'병({clean(per)})' if clean(per) else '병'

            try:
                expiry = to_date(cell(layout.get('expiry')))
            except ValueError as err:
                self.errors.append(f'{where}: {err}')
                continue

            rows.append({
                'where': where, 'cat1': CAT1_ALIASES.get(kind, kind), 'cat2': clean(cell(1)) or '(미분류)',
                'name': name, 'ingredient': clean(cell(3)), 'usage': usage,
                'unit_qty': unit_qty, 'unit_label': unit_label[:20], 'total': total, 'expiry': expiry,
            })
        return rows

    def read_promise_sheet(self, ws):
        """
        약속처방 - Code(OS·GS·GI·URI)가 있는 줄에서 세트가 시작되고, 아래 Code 빈 줄은 같은 세트의 구성 약.
        세트 하나 = 약품 하나 ('약속처방(OS)'). 수량 '3000포' → 3000포.
        """
        sets = []
        for excel_row, r in enumerate(ws.iter_rows(min_row=4, values_only=True), 4):
            r = list(r) + [None] * 6
            code, ingredient, per_dose, drug_name, usage, qty = (clean(r[0]), clean(r[1]), r[2], clean(r[3]), clean(r[4]), r[5])
            if code:
                sets.append({'code': code, 'where': f'[{ws.title}] {excel_row}행', 'usage': usage, 'qty': to_int(qty), 'items': []})
            if ingredient and sets:
                label = drug_name or ingredient
                dose = int(per_dose) if isinstance(per_dose, (int, float)) and per_dose == int(per_dose) else per_dose
                sets[-1]['items'].append((ingredient, f'{label} {dose}' if dose not in (None, '') else label))

        rows = []
        for s in sets:
            label = self.promise_label(s['code'])
            dose_text = ' + '.join(text for _, text in s['items'])
            rows.append({
                'where': s['where'], 'cat1': f'약속처방 - {label}', 'cat2': f'{label}(약속처방)',
                'name': f'약속처방({label})', 'ingredient': ', '.join(ing for ing, _ in s['items'])[:200],
                'usage': f'{s["usage"]} · 1포 = {dose_text}'[:200] if s['usage'] else f'1포 = {dose_text}'[:200],
                'unit_qty': 1, 'unit_label': '포', 'total': s['qty'], 'expiry': None, 'schedule': True,
            })
        return rows

    @staticmethod
    def promise_label(code):
        """엑셀 Code('GS') → 이미 있는 분류 이름의 표시('GS/DNT'). 없으면 Code 그대로"""
        for cat in DrugCategory1.objects.filter(name__startswith='약속처방'):
            label = clean(cat.name.split('-', 1)[-1])
            if label == code or label.split('/')[0] == code:
                return label
        return code

    # ----- DB에 넣기 -----

    def get_cat1(self, name, schedule=None):
        name = CAT1_ALIASES.get(name, name)
        for cat in DrugCategory1.objects.all():
            if name_key(cat.name) == name_key(name):
                return cat
        cat = DrugCategory1.objects.create(
            name=name, uses_dosage_schedule=USES_SCHEDULE.get(name, False) if schedule is None else schedule,
        )
        self.report['새 분류'] += 1
        self.lines.append(f'+ 분류 {name} (복용스케줄 {"켬" if cat.uses_dosage_schedule else "끔"})')
        return cat

    def get_cat2(self, name):
        name = CAT2_ALIASES.get(name, name)
        for cat in DrugCategory2.objects.all():
            if name_key(cat.name) == name_key(name):
                return cat
        self.report['새 세부 분류'] += 1
        self.lines.append(f'+ 세부 분류 {name}')
        return DrugCategory2.objects.create(name=name)

    def import_row(self, row):
        cat1 = self.get_cat1(row['cat1'], row.get('schedule'))
        cat2 = self.get_cat2(row['cat2'])

        drug = Drug.objects.filter(cat1=cat1, name=row['name']).first()
        if drug is None:
            drug = Drug.objects.create(
                cat1=cat1, cat2=cat2, name=row['name'], ingredient=row['ingredient'], usage=row['usage'],
            )
            self.report['새 약품'] += 1
            self.lines.append(f'+ 약품 [{cat1.name} / {cat2.name}] {drug.name}')
        else:
            filled = [f for f in ('ingredient', 'usage') if not getattr(drug, f) and row[f]]
            for f in filled:
                setattr(drug, f, row[f])
            if filled:
                drug.save(update_fields=filled)
                self.report['약품 빈 칸 채움'] += 1
                self.lines.append(f'~ 약품 {drug.name}: 비어 있던 {"·".join({"ingredient": "성분", "usage": "용법"}[f] for f in filled)} 채움')

        if row.get('batch_id'):
            self.check_existing_batch(row, drug)
        else:
            self.add_batch(row, drug)

    def check_existing_batch(self, row, drug):
        """배치 번호가 있는 줄 - 임시 유통기한만 채우고, 다른 차이는 알려만 준다"""
        where = row['where']
        batch = DrugBatch.objects.filter(pk=row['batch_id']).first()
        if batch is None:
            self.errors.append(f'{where}: 배치 번호 {row["batch_id"]}이(가) 없습니다. 새로 입고한 약이면 배치 번호 칸을 비워 주세요.')
            return
        if batch.drug_id != drug.id:
            self.errors.append(f'{where}: 배치 번호 {batch.id}은(는) "{batch.drug.name}"의 배치입니다. 약품명이나 배치 번호를 확인해 주세요.')
            return

        if row['expiry'] and row['expiry'] != batch.expiry_date:
            if batch.expiry_date == PLACEHOLDER_EXPIRY:
                DrugBatch.objects.filter(pk=batch.pk).update(expiry_date=row['expiry'])
                self.report['유통기한 채움'] += 1
                self.lines.append(f'~ 배치 {batch.id} {drug.name}: 유통기한 {row["expiry"]} 채움')
            else:
                self.note_diff(where, batch, drug, '유통기한', batch.expiry_date, row['expiry'])

        compare = [
            ('입고량', batch.total_qty, row['total']),
            ('창고 잔량', batch.remaining_qty, row['remaining']),
            ('포장 단위 수량', batch.unit_qty, row['unit_qty']),
            ('출처', batch.source, row['source']),
            ('입고일', batch.received_date, row['received']),
        ]
        for label, db_value, excel_value in compare:
            if excel_value not in (None, '') and excel_value != db_value:
                self.note_diff(where, batch, drug, label, db_value, excel_value)

    def note_diff(self, where, batch, drug, label, db_value, excel_value):
        labels = dict(DrugBatch.Source.choices)
        if label == '출처':
            db_value, excel_value = labels.get(db_value, db_value), labels.get(excel_value, excel_value)
        self.report['다름 (안 바뀜)'] += 1
        self.lines.append(
            f'! {where} 배치 {batch.id} {drug.name}: {label} 엑셀 {excel_value} / 지금 {db_value} - 바꾸지 않음'
            + (' ([잔량 보정]으로 고치세요)' if label in ('입고량', '창고 잔량') else '')
        )

    def add_batch(self, row, drug):
        """배치 번호가 없는 줄 = 새 입고 (입고량이 없으면 약품 정보만)"""
        if not row['total']:
            if not row.get('standard'):
                self.report['수량 없어 배치 건너뜀'] += 1
                self.lines.append(f'! {row["where"]} {drug.name}: 수량이 없어 배치를 만들지 않음')
            return
        if row.get('standard') and not (row['unit_label'] and row['unit_qty']):
            self.errors.append(f'{row["where"]}: 새 배치는 포장 단위 수량과 단위를 적어야 합니다. (예: 100, 정)')
            return

        source = row.get('source') or self.source
        unit_qty = row['unit_qty'] or 1
        key = dict(drug=drug, source=source, unit_qty=unit_qty, total_qty=row['total'])

        # 같은 약품·출처·포장·입고량의 임시 유통기한 배치가 있고 엑셀에 날짜가 있으면 그 배치의 유통기한만 채운다
        if row['expiry']:
            placeholder = DrugBatch.objects.filter(**key, expiry_date=PLACEHOLDER_EXPIRY).first()
            if placeholder:
                DrugBatch.objects.filter(pk=placeholder.pk).update(expiry_date=row['expiry'])
                self.report['유통기한 채움'] += 1
                self.lines.append(f'~ 배치 {placeholder.id} {drug.name}: 유통기한 {row["expiry"]} 채움')
                return

        expiry = row['expiry'] or PLACEHOLDER_EXPIRY
        # 같은 배치인지 볼 때: 엑셀에 유통기한이 있으면 유통기한까지 같아야 하고,
        # 비어 있으면(날짜 모름) 유통기한은 빼고 본다 - 관리자 화면에서 날짜를 채운 배치를 옛 엑셀로 다시 넣어도 두 번 들어가지 않게
        match = dict(key, expiry_date=expiry) if row['expiry'] else dict(key)
        # 같은 배치가 엑셀에 여러 줄(예: 맥페란 2줄)이어도 줄 수만큼 넣고, 다시 올리면 이미 있는 만큼 건너뛴다
        seen_key = tuple(sorted((k, getattr(v, 'id', v)) for k, v in match.items()))
        self.seen[seen_key] += 1
        if DrugBatch.objects.filter(**match).count() >= self.seen[seen_key]:
            self.report['이미 있는 배치 건너뜀'] += 1
            return

        DrugBatch.objects.create(
            **key, expiry_date=expiry, received_date=row.get('received') or self.received, unit_label=row['unit_label'][:20],
            source_detail=row.get('source_detail', '')[:100], remaining_qty=row['total'],
        )
        self.report['새 배치'] += 1
        if row['expiry'] is None:
            self.report['유통기한 미확인(임시 2099-12-31)'] += 1
        qty = f'{row["total"]}{row["unit_label"]}'
        if unit_qty > 1:
            qty += f' (1통 {unit_qty}{row["unit_label"]})'
        self.lines.append(f'+ 배치 {drug.name}: {qty}, 유통기한 {expiry if row["expiry"] else "미확인"}')

    def fix_schedule_flags(self):
        """기본 분류의 복용스케줄 여부를 정해진 값으로 맞춘다 (옛 양식 가져오기에서만 - 테스트하다 바뀐 값 정리)"""
        for cat in DrugCategory1.objects.all():
            want = USES_SCHEDULE.get(cat.name)
            if want is not None and cat.uses_dosage_schedule != want:
                cat.uses_dosage_schedule = want
                cat.save(update_fields=['uses_dosage_schedule'])
                self.report['복용스케줄 값 고침'] += 1
                self.lines.append(f'~ 분류 {cat.name}: 복용스케줄 {"켬" if want else "끔"}으로')
