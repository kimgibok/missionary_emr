from io import BytesIO
from urllib.parse import quote
from zoneinfo import ZoneInfo, available_timezones

from django.db import transaction
from django.db.models import Case, Count, F, IntegerField, Q, Sum, Value, When
from django.db.models.deletion import ProtectedError
from django.db.models.functions import Coalesce
from django.http import HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from openpyxl import Workbook
from rest_framework import generics, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from clinic.middleware import get_site_time_zone
from clinic.models import (
    Drug, DrugCategory1, DrugCategory2, DrugBatch, Mission, MissionStock,
    Prescription, PrescriptionDrug, SiteConfig, StockAdjustment,
)

from .permissions import IsSuperUser
from .serializers import (
    DrugCategory1Serializer, DrugCategory2Serializer, DrugSerializer, DrugBatchSerializer,
    MissionSerializer, MissionStockSerializer, StockAdjustmentSerializer, return_to_warehouse,
)


# =====================================================
# 공용 도우미
# =====================================================

def get_mission_param(request):
    """?mission=<id> 로 고른 미션 (없거나 숫자가 아니면 400, 없는 미션이면 404)"""
    mission_id = request.query_params.get('mission', '')
    if not mission_id.isdigit():
        raise ValidationError({'detail': 'mission 쿼리 파라미터(미션 번호)가 필요합니다.'})
    return get_object_or_404(Mission, pk=mission_id)


def parse_count(value, label):
    """0 이상의 정수만 받는다 (문자·음수·소수·True/False는 400)"""
    if isinstance(value, bool):
        raise ValidationError({'detail': f'{label}은(는) 0 이상의 정수여야 합니다.'})
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValidationError({'detail': f'{label}은(는) 0 이상의 정수여야 합니다.'})
    if number < 0 or str(number) != str(value).strip():
        raise ValidationError({'detail': f'{label}은(는) 0 이상의 정수여야 합니다.'})
    return number


def parse_adjustment(request):
    """보정 요청 body {remaining_qty, reason} 확인"""
    qty = parse_count(request.data.get('remaining_qty'), '보정할 잔량')
    reason = str(request.data.get('reason') or '').strip()
    if not reason:
        raise ValidationError({'detail': '보정 사유를 입력해주세요. (예: 파손 2개, 실사 결과)'})
    if len(reason) > 200:
        raise ValidationError({'detail': '보정 사유는 200자까지 입력할 수 있습니다.'})
    return qty, reason


def settle_stock(stock, donated):
    """
    미션 재고 하나 정산 - transaction.atomic() 안에서 부른다. 창고로 돌려준 양을 반환.
    오류 메시지에 약 이름을 넣어 한꺼번에 정산할 때도 어느 약인지 알 수 있게 한다.
    """
    name = f'{stock.drugbatch.drug.name} (유통기한 {stock.drugbatch.expiry_date})'
    if stock.is_settled:
        raise ValidationError({'detail': f'{name}: 이미 정산한 재고입니다.'})
    if donated > stock.remaining_qty:
        raise ValidationError({'detail': f'{name}: 기부량이 현장 잔량({stock.remaining_qty})보다 많습니다.'})
    # 조회한 뒤 다른 요청이 잔량·정산 상태를 바꿨으면 정산하지 않는다
    ok = MissionStock.objects.filter(
        id=stock.id, is_settled=False, remaining_qty=stock.remaining_qty,
    ).update(is_settled=True, donated_qty=donated)
    if not ok:
        raise ValidationError({'detail': f'{name}: 그 사이 재고가 바뀌었습니다. 새로고침 후 다시 정산하세요.'})
    returned = stock.remaining_qty - donated
    return_to_warehouse(stock.drugbatch_id, returned)
    return returned


class ProtectedDeleteMixin:
    """다른 데이터가 쓰고 있어(PROTECT) 못 지우면 500 대신 400으로 알려준다"""
    protected_message = '다른 데이터에서 쓰고 있어 삭제할 수 없습니다.'

    def perform_destroy(self, instance):
        try:
            with transaction.atomic():
                instance.delete()
        except ProtectedError:
            raise ValidationError({'detail': self.protected_message})


# =====================================================
# 미션 탭
# =====================================================

class MissionListView(generics.ListAPIView):
    """관리자 - 미션 탭 목록. 진행중인 미션 먼저, 이후 최신순"""
    serializer_class = MissionSerializer
    permission_classes = [IsSuperUser]

    def get_queryset(self):
        today = timezone.localdate()
        return Mission.objects.annotate(
            active_order=Case(
                When(start_date__lte=today, end_date__gte=today, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            )
        ).order_by('active_order', '-start_date')


# =====================================================
# 약품 · 분류 CRUD
# =====================================================

class DrugCategory1ViewSet(ProtectedDeleteMixin, viewsets.ModelViewSet):
    queryset = DrugCategory1.objects.order_by('name')
    serializer_class = DrugCategory1Serializer
    permission_classes = [IsSuperUser]
    protected_message = '이 분류를 쓰는 약품이 있어 삭제할 수 없습니다. 약품의 분류를 먼저 바꾸세요.'


class DrugCategory2ViewSet(ProtectedDeleteMixin, viewsets.ModelViewSet):
    queryset = DrugCategory2.objects.order_by('name')
    serializer_class = DrugCategory2Serializer
    permission_classes = [IsSuperUser]
    protected_message = '이 세부 분류를 쓰는 약품이 있어 삭제할 수 없습니다. 약품의 분류를 먼저 바꾸세요.'


class DrugViewSet(ProtectedDeleteMixin, viewsets.ModelViewSet):
    """약품 (?search= 이름·성분, ?cat1=, ?cat2=)"""
    serializer_class = DrugSerializer
    permission_classes = [IsSuperUser]
    protected_message = '입고 배치나 처방에 쓰인 약품이라 삭제할 수 없습니다.'

    def get_queryset(self):
        qs = Drug.objects.select_related('cat1', 'cat2').order_by('name')
        params = self.request.query_params
        if params.get('search'):
            qs = qs.filter(Q(name__icontains=params['search']) | Q(ingredient__icontains=params['search']))
        if params.get('cat1'):
            qs = qs.filter(cat1_id=params['cat1'])
        if params.get('cat2'):
            qs = qs.filter(cat2_id=params['cat2'])
        return qs


# =====================================================
# 창고 재고 (DrugBatch) - 잔량은 배분·정산으로 자동, 실사 차이는 adjust로 직접 보정
# =====================================================

class DrugBatchViewSet(ProtectedDeleteMixin, viewsets.ModelViewSet):
    """창고 배치 (?drug=, ?search= 약 이름·성분), 약 이름·유통기한 순"""
    serializer_class = DrugBatchSerializer
    permission_classes = [IsSuperUser]
    protected_message = '미션에 배분된 배치라 삭제할 수 없습니다. 미션 재고에서 배분을 먼저 지우세요.'

    def get_queryset(self):
        qs = DrugBatch.objects.select_related('drug').order_by('drug__name', 'expiry_date', 'id')
        params = self.request.query_params
        if params.get('drug'):
            qs = qs.filter(drug_id=params['drug'])
        if params.get('search'):
            qs = qs.filter(Q(drug__name__icontains=params['search']) | Q(drug__ingredient__icontains=params['search']))
        return qs

    @action(detail=True, methods=['post'])
    def adjust(self, request, pk=None):
        """창고 잔량 직접 보정 {remaining_qty, reason} - 보정 이력이 남는다"""
        qty, reason = parse_adjustment(request)
        with transaction.atomic():
            batch = self.get_object()
            before = batch.remaining_qty
            DrugBatch.objects.filter(id=batch.id).update(remaining_qty=qty)
            StockAdjustment.objects.create(
                drugbatch=batch, before_qty=before, after_qty=qty, reason=reason, adjusted_by=request.user,
            )
        batch.refresh_from_db()
        return Response(self.get_serializer(batch).data)


# =====================================================
# 미션 재고 (MissionStock) - 배분·배분량 수정·삭제·정산·보정
# =====================================================

class MissionStockViewSet(viewsets.ModelViewSet):
    """미션 재고 (?mission= 필수에 가깝게 씀, ?search=), 약 이름·유통기한 순. used_qty = 실제로 수령된 양"""
    serializer_class = MissionStockSerializer
    permission_classes = [IsSuperUser]

    def get_queryset(self):
        qs = (
            MissionStock.objects.select_related('drugbatch__drug__cat1')
            .annotate(used_qty=Coalesce(Sum('dispensed_items__quantity'), 0))
            .order_by('drugbatch__drug__name', 'drugbatch__expiry_date', 'id')
        )
        params = self.request.query_params
        if params.get('mission'):
            qs = qs.filter(mission_id=params['mission'])
        if params.get('search'):
            qs = qs.filter(
                Q(drugbatch__drug__name__icontains=params['search']) |
                Q(drugbatch__drug__ingredient__icontains=params['search'])
            )
        return qs

    def perform_destroy(self, instance):
        """배분 취소 - 현장 잔량을 창고로 돌려준다. 조제에 쓰였거나 정산이 끝났으면 못 지운다"""
        if instance.is_settled:
            raise ValidationError({'detail': '정산이 끝난 재고는 삭제할 수 없습니다.'})
        if instance.dispensed_items.exists():
            raise ValidationError({'detail': '조제에 쓰인 재고라 삭제할 수 없습니다. 남은 만큼 배분량을 줄이세요.'})
        try:
            with transaction.atomic():
                return_to_warehouse(instance.drugbatch_id, instance.remaining_qty)
                instance.delete()
        except ProtectedError:   # 확인과 삭제 사이에 조제가 들어온 경우
            raise ValidationError({'detail': '조제에 쓰인 재고라 삭제할 수 없습니다. 남은 만큼 배분량을 줄이세요.'})

    @action(detail=True, methods=['post'])
    def adjust(self, request, pk=None):
        """현장 잔량 직접 보정 {remaining_qty, reason} - 정산 전만, 보정 이력이 남는다"""
        qty, reason = parse_adjustment(request)
        with transaction.atomic():
            stock = self.get_object()
            if stock.is_settled:
                raise ValidationError({'detail': '정산이 끝난 재고는 보정할 수 없습니다.'})
            before = stock.remaining_qty
            MissionStock.objects.filter(id=stock.id).update(remaining_qty=qty)
            StockAdjustment.objects.create(
                mission_stock=stock, before_qty=before, after_qty=qty, reason=reason, adjusted_by=request.user,
            )
        return Response(self.get_serializer(self.get_object()).data)

    @action(detail=True, methods=['post'])
    def settle(self, request, pk=None):
        """
        정산 {donated_qty} - 현장 잔량 중 기부량을 뺀 나머지를 창고로 돌려주고 정산 완료.
        현장 잔량은 '정산 때 남아 있던 양' 기록으로 그대로 둔다. 두 번 정산할 수 없다.
        """
        donated = parse_count(request.data.get('donated_qty', 0), '기부량')
        with transaction.atomic():
            stock = self.get_object()
            returned = settle_stock(stock, donated)

        warehouse_left = DrugBatch.objects.get(id=stock.drugbatch_id).remaining_qty
        return Response({
            'donated_qty': donated,
            'returned_qty': returned,
            'drugbatch_remaining_qty': warehouse_left,
        })

    @action(detail=False, methods=['post'], url_path='settle-bulk')
    def settle_bulk(self, request):
        """
        한꺼번에 정산 {items: [{id, donated_qty}, ...]} - 하나라도 안 되면 전부 취소(모두 정산 전 그대로).
        donated_qty를 빼면 0(기부 없음)으로 본다.
        """
        items = request.data.get('items')
        if not isinstance(items, list) or not items:
            raise ValidationError({'detail': '정산할 재고를 하나 이상 골라주세요.'})

        parsed = []
        for entry in items:
            if not isinstance(entry, dict):
                raise ValidationError({'detail': '정산 항목 형식이 올바르지 않습니다.'})
            stock_id = parse_count(entry.get('id'), '재고 번호')
            parsed.append((stock_id, parse_count(entry.get('donated_qty', 0), '기부량')))
        if len({stock_id for stock_id, _ in parsed}) != len(parsed):
            raise ValidationError({'detail': '같은 재고가 두 번 들어 있습니다.'})

        stocks = MissionStock.objects.select_related('drugbatch__drug').in_bulk([stock_id for stock_id, _ in parsed])
        returned_total = 0
        with transaction.atomic():
            for stock_id, donated in parsed:
                stock = stocks.get(stock_id)
                if stock is None:
                    raise ValidationError({'detail': f'없는 재고입니다. (번호 {stock_id}) 새로고침 후 다시 시도하세요.'})
                returned_total += settle_stock(stock, donated)

        return Response({'settled': len(parsed), 'returned_qty': returned_total})


class StockAdjustmentListView(generics.ListAPIView):
    """보정 이력 (?drugbatch= 또는 ?mission_stock=), 최신순"""
    serializer_class = StockAdjustmentSerializer
    permission_classes = [IsSuperUser]

    def get_queryset(self):
        params = self.request.query_params
        qs = StockAdjustment.objects.select_related('adjusted_by').order_by('-adjusted_at', '-id')
        if params.get('drugbatch'):
            return qs.filter(drugbatch_id=params['drugbatch'])
        if params.get('mission_stock'):
            return qs.filter(mission_stock_id=params['mission_stock'])
        raise ValidationError({'detail': 'drugbatch 또는 mission_stock 쿼리 파라미터가 필요합니다.'})


# =====================================================
# 설정 - 현장 시간대
# =====================================================

class SiteConfigView(APIView):
    """
    GET: 현장 시간대 + 서버 기준 오늘 날짜·지금 시각 (설정 실수를 바로 알아보게)
    PATCH {time_zone}: 시간대 변경 (IANA 이름, 예: 'Asia/Phnom_Penh'). 다음 요청부터 모든 기기에 적용된다.
    시각 글자(server_time 등)는 서버가 현장 시간대로 만들어 준다 - 기기 시간대가 달라도 서버 기준으로 보이게.
    """
    permission_classes = [IsSuperUser]

    def get(self, request):
        return Response(self.site_config_data())

    def patch(self, request):
        name = str(request.data.get('time_zone') or '').strip()
        if name not in available_timezones():
            raise ValidationError({'detail': f'알 수 없는 시간대입니다: {name or "(빈 값)"}. 예: Asia/Phnom_Penh'})
        with transaction.atomic():
            config = SiteConfig.load()
            config.time_zone = name
            config.updated_by = request.user
            config.updated_at = timezone.now()
            config.save()
        # 이 요청은 바꾸기 전 시간대로 시작했으므로 새 시간대로 다시 켜서 응답한다
        timezone.activate(ZoneInfo(name))
        return Response(self.site_config_data())

    @staticmethod
    def site_config_data():
        config = SiteConfig.objects.filter(pk=1).select_related('updated_by').first()
        now = timezone.localtime()
        updated_by = config.updated_by if config else None
        return {
            'time_zone': get_site_time_zone(),
            'is_default': not (config and config.time_zone),    # 관리자 화면에서 아직 안 골랐으면 True
            'server_today': timezone.localdate(),
            'server_time': now.strftime('%H:%M'),
            'server_wall': now.strftime('%Y-%m-%dT%H:%M:%S'),   # 기기 시계와 비교용 (현장 벽시계 시각)
            'utc_offset': now.strftime('%z'),                    # '+0700'
            'updated_by_name': (updated_by.name or updated_by.username) if updated_by else '',
            'updated_at': timezone.localtime(config.updated_at).strftime('%Y-%m-%d %H:%M') if config and config.updated_at else '',
        }


# =====================================================
# 통계 - 화면(API)과 엑셀이 같은 계산을 쓴다
# =====================================================

AGE_SEX_COLUMNS = [('소아', 'M'), ('소아', 'F'), ('성인', 'M'), ('성인', 'F')]


def age_group(visit_date, birth_year):
    """소아 = 19세 이하, 성인 = 20세 이상 (나이 = 방문연도 − 출생연도)"""
    return '소아' if visit_date.year - birth_year <= 19 else '성인'


def compute_visit_stats(mission):
    """
    진료과별 환자 수 - 진료 완료된 배정의 처방 기준.
    같은 과 처방이 여러 건이어도 그 방문은 1명, 두 과를 본 방문은 각 과에 1명씩.
    """
    rows = (
        Prescription.objects.filter(visit_department__visit__mission=mission, visit_department__is_done=True)
        .values(
            'department__name',
            visit_id=F('visit_department__visit_id'),
            visit_date=F('visit_department__visit__visit_date'),
            patient_id=F('visit_department__visit__patient_id'),
            sex=F('visit_department__visit__patient__sex'),
            birth_year=F('visit_department__visit__patient__birth_year'),
        )
        .distinct()
    )

    visits = {}         # 방문 id → (소아/성인, 성별)
    patients = set()
    dept_counts = {}    # (진료과, 소아/성인, 성별) → 방문 수
    seen = set()        # (방문, 진료과) 중복 방지
    for r in rows:
        key = (r['visit_id'], r['department__name'])
        if key in seen:
            continue
        seen.add(key)
        group = (age_group(r['visit_date'], r['birth_year']), r['sex'])
        visits[r['visit_id']] = group
        patients.add(r['patient_id'])
        dept_key = (r['department__name'],) + group
        dept_counts[dept_key] = dept_counts.get(dept_key, 0) + 1

    by_age_sex = {col: 0 for col in AGE_SEX_COLUMNS}
    for group in visits.values():
        by_age_sex[group] += 1

    return {
        'total_visits': len(visits),
        'total_patients': len(patients),
        'by_age_sex': [{'age_group': a, 'sex': s, 'count': by_age_sex[(a, s)]} for a, s in AGE_SEX_COLUMNS],
        'rows': [
            {'department': d, 'age_group': a, 'sex': s, 'count': c}
            for (d, a, s), c in sorted(dept_counts.items(), key=lambda x: (x[0][0], x[0][1] != '소아', x[0][2]))
        ],
    }


def compute_drug_stats(mission):
    """
    약 통계 - 수령 처리된 약만 센다.
    by_cat1·by_cat2: 분류별 사용량 / by_department: 진료과별 사용량·약 종수·환자 수 / department_drugs: 진료과 × 약
    prep: 다음 미션 준비표 - 약마다 챙겨 간 양·쓴 양·남은 양·기부량·하루 평균(수령 처리가 있던 날 평균)
    """
    items = PrescriptionDrug.objects.filter(
        prescription__visit_department__visit__mission=mission, prescription__is_dispensed=True,
    )

    def by(field):
        return [
            {'name': r[field] or '(없음)', 'total_quantity': r['total'], 'drug_kinds': r['kinds']}
            for r in items.values(field).annotate(total=Sum('quantity'), kinds=Count('drug', distinct=True))
            .order_by('-total', field)
        ]

    by_department = [
        {
            'name': r['prescription__department__name'], 'total_quantity': r['total'],
            'drug_kinds': r['kinds'], 'patients': r['patients'],
        }
        for r in items.values('prescription__department__name')
        .annotate(
            total=Sum('quantity'), kinds=Count('drug', distinct=True),
            patients=Count('prescription__visit_department__visit', distinct=True),
        )
        .order_by('-total', 'prescription__department__name')
    ]
    department_drugs = [
        {'department': r['prescription__department__name'], 'drug_name': r['drug__name'], 'total_quantity': r['total']}
        for r in items.values('prescription__department__name', 'drug__name')
        .annotate(total=Sum('quantity'))
        .order_by('prescription__department__name', '-total', 'drug__name')
    ]

    # ----- 다음 미션 준비표 -----
    days_worked = (
        Prescription.objects.filter(visit_department__visit__mission=mission, is_dispensed=True)
        .values('visit_department__visit__visit_date').distinct().count()
    )
    used = {r['drug_id']: r['total'] for r in items.values('drug_id').annotate(total=Sum('quantity'))}
    prep = {}
    for r in (
        MissionStock.objects.filter(mission=mission)
        .values('drugbatch__drug_id', 'drugbatch__drug__name', 'drugbatch__drug__cat1__name')
        .annotate(allocated=Sum('allocated_qty'), remaining=Sum('remaining_qty'), donated=Sum('donated_qty'))
    ):
        prep[r['drugbatch__drug_id']] = {
            'drug_name': r['drugbatch__drug__name'], 'cat1_name': r['drugbatch__drug__cat1__name'],
            'allocated_qty': r['allocated'], 'remaining_qty': r['remaining'], 'donated_qty': r['donated'],
        }
    # 미션 재고 없이 쓰인 약(예전 데이터)도 표에 넣는다
    for drug in Drug.objects.filter(id__in=set(used) - set(prep)).select_related('cat1'):
        prep[drug.id] = {
            'drug_name': drug.name, 'cat1_name': drug.cat1.name,
            'allocated_qty': 0, 'remaining_qty': 0, 'donated_qty': 0,
        }
    prep_rows = []
    for drug_id, row in prep.items():
        used_qty = used.get(drug_id, 0)
        prep_rows.append({
            'drug_id': drug_id, **row, 'used_qty': used_qty,
            'daily_avg': round(used_qty / days_worked, 1) if days_worked else 0,
        })
    prep_rows.sort(key=lambda r: (r['cat1_name'], r['drug_name']))

    return {
        'by_cat1': by('drug__cat1__name'),
        'by_cat2': by('drug__cat2__name'),
        'by_department': by_department,
        'department_drugs': department_drugs,
        'days_worked': days_worked,
        'prep': prep_rows,
    }


class VisitStatsView(APIView):
    """환자 통계 (?mission=) - 소아/성인 × 성별 × 진료과별 환자 수, 전체 방문 수·실제 환자 수"""
    permission_classes = [IsSuperUser]

    def get(self, request):
        return Response(compute_visit_stats(get_mission_param(request)))


class DrugStatsView(APIView):
    """약 통계 (?mission=) - 분류별·진료과별 사용량, 다음 미션 준비표"""
    permission_classes = [IsSuperUser]

    def get(self, request):
        return Response(compute_drug_stats(get_mission_param(request)))


# =====================================================
# 엑셀 export - 통계 시트 4개 + 분류(cat1)별 미션 재고 시트
# =====================================================

SEX_LABEL = {'M': '남', 'F': '여'}


def add_visit_stats_sheet(wb, stats):
    ws = wb.create_sheet('환자 통계')
    ws.append(['전체 방문 수', stats['total_visits'], '실제 환자 수', stats['total_patients']])
    ws.append([])
    headers = [f'{a} {SEX_LABEL[s]}' for a, s in AGE_SEX_COLUMNS]
    ws.append(['진료과', *headers, '합계'])
    table = {}
    for r in stats['rows']:
        table.setdefault(r['department'], {})[(r['age_group'], r['sex'])] = r['count']
    for dept, counts in table.items():
        values = [counts.get(col, 0) for col in AGE_SEX_COLUMNS]
        ws.append([dept, *values, sum(values)])
    by_age_sex = {(r['age_group'], r['sex']): r['count'] for r in stats['by_age_sex']}
    values = [by_age_sex[col] for col in AGE_SEX_COLUMNS]
    ws.append(['전체 (방문 기준)', *values, sum(values)])


def add_drug_stats_sheets(wb, stats):
    ws = wb.create_sheet('약 분류별')
    ws.append(['분류', '사용량', '약 종수'])
    for r in stats['by_cat1']:
        ws.append([r['name'], r['total_quantity'], r['drug_kinds']])
    ws.append([])
    ws.append(['세부 분류', '사용량', '약 종수'])
    for r in stats['by_cat2']:
        ws.append([r['name'], r['total_quantity'], r['drug_kinds']])

    ws = wb.create_sheet('진료과별')
    ws.append(['진료과', '사용량', '약 종수', '환자 수'])
    for r in stats['by_department']:
        ws.append([r['name'], r['total_quantity'], r['drug_kinds'], r['patients']])
    ws.append([])
    ws.append(['진료과', '약', '사용량'])
    for r in stats['department_drugs']:
        ws.append([r['department'], r['drug_name'], r['total_quantity']])

    ws = wb.create_sheet('다음 미션 준비표')
    ws.append([f"진료한 날 {stats['days_worked']}일 기준"])
    ws.append(['분류', '약', '챙겨 간 양', '쓴 양', '남은 양', '기부량', '하루 평균'])
    for r in stats['prep']:
        ws.append([
            r['cat1_name'], r['drug_name'], r['allocated_qty'], r['used_qty'],
            r['remaining_qty'], r['donated_qty'], r['daily_avg'],
        ])


class MissionStockExportView(APIView):
    """미션 엑셀 (?mission=) - 환자 통계·약 분류별·진료과별·다음 미션 준비표 + 분류별 미션 재고"""
    permission_classes = [IsSuperUser]

    def get(self, request):
        mission = get_mission_param(request)

        wb = Workbook()
        wb.remove(wb.active)  # 기본으로 딸려오는 빈 시트 제거
        add_visit_stats_sheet(wb, compute_visit_stats(mission))
        add_drug_stats_sheets(wb, compute_drug_stats(mission))

        used = dict(
            MissionStock.objects.filter(mission=mission)
            .annotate(used=Coalesce(Sum('dispensed_items__quantity'), 0))
            .values_list('id', 'used')
        )
        taken = {ws.title for ws in wb.worksheets}
        for cat1 in DrugCategory1.objects.order_by('name'):
            stocks = (
                MissionStock.objects.filter(mission=mission, drugbatch__drug__cat1=cat1)
                .select_related('drugbatch__drug')
                .order_by('drugbatch__drug__name', 'drugbatch__expiry_date')
            )
            if not stocks.exists():
                continue
            title = f'재고-{cat1.name}'[:31]  # 시트명 31자 제한, 통계 시트와 이름이 겹치지 않게 '재고-'를 붙인다
            if title in taken:
                continue
            taken.add(title)
            ws = wb.create_sheet(title=title)
            ws.append(['약품명', '성분', '유통기한', '출처', '배분량', '쓴 양', '현장 잔량', '기부량', '정산'])
            for s in stocks:
                ws.append([
                    s.drugbatch.drug.name,
                    s.drugbatch.drug.ingredient,
                    str(s.drugbatch.expiry_date),
                    s.drugbatch.get_source_display(),
                    s.allocated_qty,
                    used.get(s.id, 0),
                    s.remaining_qty,
                    s.donated_qty,
                    '완료' if s.is_settled else '',
                ])

        buffer = BytesIO()
        wb.save(buffer)
        filename = f'{mission.country}_{mission.start_date}_미션통계.xlsx'
        response = HttpResponse(
            buffer.getvalue(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        # 한글 파일명은 filename*(RFC 5987)로, 옛 브라우저용 filename은 영문으로
        response['Content-Disposition'] = (
            f'attachment; filename="mission_{mission.id}_stats.xlsx"; filename*=UTF-8\'\'{quote(filename)}'
        )
        return response
