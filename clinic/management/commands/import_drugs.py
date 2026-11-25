"""
약품 리스트 엑셀 → 분류(DrugCategory1·2) · 약품(Drug) · 창고 배치(DrugBatch)

    python manage.py import_drugs "db/약품_리스트_아가페_2026_약품분류용1.xlsx"            # 미리보기 (DB 그대로)
    python manage.py import_drugs "db/약품_리스트_아가페_2026_약품분류용1.xlsx" --commit   # 실제로 넣기

규칙
- 시트 이름 '2026-경구' → 분류 '경구'. 시트 안 '분류' 열 → 세부 분류. 이름은 띄어쓰기를 무시하고 비교해 이미 있는 이름을 쓴다.
- 같은 분류 안에서 약품명이 같으면 한 약품. 엑셀 한 줄 = 창고 배치 하나 (잔량 = 입고량).
- 이미 있는 약품은 비어 있는 성분·용법만 채운다(고쳐 둔 값은 덮어쓰지 않는다).
- 이미 넣은 배치는 다시 넣지 않는다 - (약품·출처·유통기한·포장 단위·입고량)이 같은 배치가 DB에 있는 만큼 건너뛴다. 두 번 돌려도 안전하다.
- 유통기한이 없는 시트(경구·비타민·소아·약속처방)는 임시 날짜 2099-12-31로 넣는다 → 관리자 [창고 재고]에서 실제 날짜로 고친다.
- 미리보기도 실제와 같은 코드로 넣어 보고 마지막에 되돌린다. --commit이면 하나라도 오류가 나면 전부 취소된다.
- 미션 배분(MissionStock)은 만들지 않는다 - 관리자 [미션 재고] 탭에서 배분한다.
"""
import datetime
import re
from collections import Counter

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from openpyxl import load_workbook

from clinic.models import Drug, DrugBatch, DrugCategory1, DrugCategory2

PLACEHOLDER_EXPIRY = datetime.date(2099, 12, 31)    # 유통기한 미확인 표시용 임시 날짜

# 분류 이름 맞추기 (엑셀 이름 → DB 이름)
CAT1_ALIASES = {'외용약': '외용'}
CAT2_ALIASES = {'정맥순한개선제': '정맥순환개선제'}   # 엑셀 오타

# 분류마다 처방할 때 복용스케줄(1회량·횟수·일수)로 입력할지
# 소아는 시럽이라 재고 단위가 '병'이다 - 스케줄로 계산하면 ml 수(예: 45)가 나와 재고와 안 맞으므로 병 수를 직접 입력한다
USES_SCHEDULE = {'경구': True, '비타민': True, '소아': False, '외용': False, '주사제': False, '추가약': False}

# 시트 종류별 열 위치 (0부터). 데이터는 4행부터, 'No.'가 숫자인 줄만 읽는다.
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
    """'2028.10.29' 또는 엑셀 날짜 → date / 비었으면 None"""
    if value in (None, ''):
        return None
    if isinstance(value, datetime.datetime):
        return value.date()
    if isinstance(value, datetime.date):
        return value
    match = re.fullmatch(r'(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})', clean(value))
    if not match:
        raise ValueError(f'유통기한 형식을 모르겠습니다: {value}')
    return datetime.date(*map(int, match.groups()))


def guess_unit(name, usage):
    """경구약 낱개 단위 추정 - 엑셀에 없어서 용법·이름으로 짐작한다 (관리자 화면에서 고칠 수 있다)"""
    if re.search(r'\d\s*포', usage):
        return '포'
    if '캡슐' in name or '캡슐' in usage:
        return '캡슐'
    if '패취' in name or '패치' in name:
        return '매'
    return '정'


class Command(BaseCommand):
    help = '약품 리스트 엑셀을 분류·약품·창고 배치로 가져온다 (기본은 미리보기, --commit이면 실제로 넣는다)'

    def add_arguments(self, parser):
        parser.add_argument('path', help='엑셀 파일 경로')
        parser.add_argument('--commit', action='store_true', help='실제로 DB에 넣는다 (없으면 미리보기)')
        parser.add_argument(
            '--source', default='donation', choices=[c for c, _ in DrugBatch.Source.choices],
            help='배치 출처 (기본 donation=후원)',
        )
        parser.add_argument('--received-date', help='입고일 YYYY-MM-DD (기본 오늘)')

    # ----- 진입점 -----

    def handle(self, *args, **options):
        try:
            self.received = (
                datetime.date.fromisoformat(options['received_date']) if options['received_date'] else timezone.localdate()
            )
        except ValueError:
            raise CommandError('--received-date는 YYYY-MM-DD 형식이어야 합니다.')
        self.source = options['source']

        try:
            wb = load_workbook(options['path'], read_only=True, data_only=True)
        except FileNotFoundError:
            raise CommandError(f'파일이 없습니다: {options["path"]}')

        rows = self.read_workbook(wb)
        if not rows:
            raise CommandError('가져올 약이 없습니다. 시트 이름(예: 2026-경구)과 열 순서를 확인하세요.')

        self.report = Counter()     # 종류별 건수 (마지막 요약)
        self.lines = []             # 줄마다 한 일 (미리보기 목록)
        self.seen = Counter()       # 이번 엑셀에서 같은 배치가 몇 번째로 나왔는지
        try:
            with transaction.atomic():
                for row in rows:
                    self.import_row(row)
                self.fix_schedule_flags()
                if not options['commit']:
                    transaction.set_rollback(True)  # 미리보기 - 넣어 본 것을 되돌린다
        except ValueError as err:
            raise CommandError(str(err))

        self.print_report(options['commit'])

    # ----- 엑셀 읽기 → 줄 목록 -----

    def read_workbook(self, wb):
        rows = []
        for ws in wb.worksheets:
            kind = ws.title.split('-', 1)[-1].strip()
            if kind == PROMISE_SHEET:
                rows += self.read_promise_sheet(ws)
            elif kind in SHEET_LAYOUTS:
                rows += self.read_drug_sheet(ws, kind)
            else:
                self.stdout.write(self.style.WARNING(f'[{ws.title}] 모르는 시트라 건너뜁니다.'))
        return rows

    def read_drug_sheet(self, ws, kind):
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
                raise CommandError(f'{where}: {err}')

            rows.append({
                'where': where, 'cat1': CAT1_ALIASES.get(kind, kind), 'cat2': clean(cell(1)) or '(미분류)',
                'name': name, 'ingredient': clean(cell(3)), 'usage': usage,
                'unit_qty': unit_qty, 'unit_label': unit_label[:20], 'total': total, 'expiry': expiry,
            })
        return rows

    def read_promise_sheet(self, ws):
        """
        약속처방 - Code(OS·GS·GI·URI)가 있는 줄에서 세트가 시작되고, 아래 Code 빈 줄은 같은 세트의 구성 약.
        세트 하나 = 약품 하나 (DB에 손으로 넣어 둔 '약속처방(OS)'와 같은 방식). 수량 '3000포' → 3000포.
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

    def promise_label(self, code):
        """엑셀 Code('GS') → 이미 있는 분류 이름의 표시('GS/DNT'). 없으면 Code 그대로"""
        for cat in DrugCategory1.objects.filter(name__startswith='약속처방'):
            label = clean(cat.name.split('-', 1)[-1])
            if label == code or label.split('/')[0] == code:
                return label
        return code

    # ----- DB에 넣기 -----

    def get_cat1(self, name, schedule=None):
        for cat in DrugCategory1.objects.all():
            if name_key(cat.name) == name_key(name):
                return cat
        cat = DrugCategory1.objects.create(
            name=name, uses_dosage_schedule=USES_SCHEDULE.get(name, False) if schedule is None else schedule,
        )
        self.report['새 분류'] += 1
        self.lines.append(f'  + 분류 {name} (복용스케줄 {"켬" if cat.uses_dosage_schedule else "끔"})')
        return cat

    def get_cat2(self, name):
        name = CAT2_ALIASES.get(name, name)
        for cat in DrugCategory2.objects.all():
            if name_key(cat.name) == name_key(name):
                return cat
        self.report['새 세부 분류'] += 1
        self.lines.append(f'  + 세부 분류 {name}')
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
            self.lines.append(f'  + 약품 [{cat1.name}/{cat2.name}] {drug.name}')
        else:
            filled = [f for f in ('ingredient', 'usage') if not getattr(drug, f) and row[f]]
            for f in filled:
                setattr(drug, f, row[f])
            if filled:
                drug.save(update_fields=filled)
                self.report['기존 약품 빈 칸 채움'] += 1
                self.lines.append(f'  ~ 약품 {drug.name}: 비어 있던 {"·".join({"ingredient": "성분", "usage": "용법"}[f] for f in filled)} 채움')

        if not row['total']:
            self.report['수량 없어 배치 건너뜀'] += 1
            self.lines.append(f'  ! {row["where"]} {drug.name}: 수량이 없어 배치를 만들지 않음')
            return

        expiry = row['expiry'] or PLACEHOLDER_EXPIRY
        key = dict(drug=drug, source=self.source, expiry_date=expiry, unit_qty=row['unit_qty'], total_qty=row['total'])
        # 같은 배치가 엑셀에 여러 줄(예: 맥페란 2줄)이어도 줄 수만큼 넣고, 다시 돌리면 이미 있는 만큼 건너뛴다
        seen_key = tuple(sorted((k, getattr(v, 'id', v)) for k, v in key.items()))
        self.seen[seen_key] += 1
        if DrugBatch.objects.filter(**key).count() >= self.seen[seen_key]:
            self.report['이미 있는 배치 건너뜀'] += 1
            return

        DrugBatch.objects.create(
            **key, received_date=self.received, unit_label=row['unit_label'], remaining_qty=row['total'],
        )
        self.report['새 배치'] += 1
        if row['expiry'] is None:
            self.report['유통기한 임시(2099-12-31)'] += 1
        qty = f'{row["total"]}{row["unit_label"]}'
        if row['unit_qty'] > 1:
            qty += f' (1통 {row["unit_qty"]}{row["unit_label"]})'
        self.lines.append(f'    배치 {drug.name}: {qty}, 유통기한 {expiry if row["expiry"] else "임시 2099-12-31"}')

    def fix_schedule_flags(self):
        """기본 분류의 복용스케줄 여부를 정해진 값으로 맞춘다 (테스트하다 바뀐 값 정리)"""
        for cat in DrugCategory1.objects.all():
            want = USES_SCHEDULE.get(cat.name)
            if want is not None and cat.uses_dosage_schedule != want:
                cat.uses_dosage_schedule = want
                cat.save(update_fields=['uses_dosage_schedule'])
                self.report['복용스케줄 값 고침'] += 1
                self.lines.append(f'  ~ 분류 {cat.name}: 복용스케줄 {"켬" if want else "끔"}으로')

    # ----- 결과 -----

    def print_report(self, committed):
        self.stdout.write('\n'.join(self.lines))
        self.stdout.write('')
        summary = ', '.join(f'{k} {v}' for k, v in self.report.items()) or '바뀐 것 없음'
        if committed:
            self.stdout.write(self.style.SUCCESS(f'넣었습니다: {summary}'))
            if self.report['유통기한 임시(2099-12-31)']:
                self.stdout.write(self.style.WARNING(
                    '유통기한이 2099-12-31인 배치는 임시 날짜입니다. 관리자 [창고 재고]에서 실제 날짜로 고치세요.'
                ))
        else:
            self.stdout.write(self.style.WARNING(f'미리보기 (DB는 그대로): {summary}'))
            self.stdout.write('실제로 넣으려면 같은 명령에 --commit 을 붙이세요.')
