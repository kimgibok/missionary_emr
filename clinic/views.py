from collections import defaultdict

from django.db import transaction
from django.db.models import Count, F, Max, Q, Sum
from django.shortcuts import get_object_or_404
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import generics, status
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import (
    Patient, Visit, VisitDepartment, MissionMembership, Department, DrugCategory1, DrugCategory2,
    Prescription, PrescriptionDrug, MissionStock,
)
from .permissions import (
    get_active_memberships,
    IsReceptionTeam, IsClinicalTeam, IsPharmacyTeam,
    IsInfoOrReceptionTeam, IsReceptionOrClinicalTeam, IsInfoOrReceptionOrClinicalTeam, IsClinicalOrPharmacyTeam,
    IsAssignedDoctor, IsPrescriptionOwner, CanCancelAssignment,
    can_add_assignment, owns_visit_department, is_assigned_to_visit,
)
from .serializers import (
    PatientSerializer,
    VisitCreateSerializer, VisitVitalsSerializer, VisitIntakeListSerializer, VisitIntakeDetailSerializer,
    VisitDepartmentCreateSerializer, VisitDepartmentListSerializer, VisitDepartmentDetailSerializer,
    VisitDepartmentDoneSerializer,
    DepartmentSerializer, DrugCategory1ReadSerializer, DrugCategory2ReadSerializer, DrugSearchSerializer,
    PrescriptionCreateSerializer, PrescriptionListSerializer, PrescriptionUpdateSerializer,
    PrescriptionDrugCreateSerializer, PrescriptionDrugClinicalUpdateSerializer, PrescriptionDrugUpdateSerializer,
    MissionStockSerializer, PharmacyVisitSerializer,
)


def get_current_mission(user):
    """로그인한 유저의 현재 진행중인 미션 (여러 개면 일단 첫 번째로 처리)"""
    membership = get_active_memberships(user).first()
    return membership.mission if membership else None


# =====================================================
# 환자 / 방문 (안내팀·접수팀, 일부 진료팀 공용)
# =====================================================

class PatientListCreateView(generics.ListCreateAPIView):
    """환자 검색(?search=&scope=current_mission) / 신규 등록 - 안내팀·접수팀"""
    serializer_class = PatientSerializer
    permission_classes = [IsInfoOrReceptionTeam]

    def get_queryset(self):
        qs = Patient.objects.all()
        search = self.request.query_params.get('search')
        scope = self.request.query_params.get('scope')

        if scope == 'current_mission':
            mission = get_current_mission(self.request.user)
            qs = qs.filter(visits__mission=mission).distinct() if mission else qs.none()

        if search:
            qs = qs.filter(Q(name_kr__icontains=search) | Q(name_local__icontains=search))
        return qs


class PatientDetailView(generics.RetrieveUpdateAPIView):
    """환자 기본정보 조회/수정 - 안내팀·접수팀·진료팀 공용"""
    queryset = Patient.objects.all()
    serializer_class = PatientSerializer
    permission_classes = [IsInfoOrReceptionOrClinicalTeam]


class VisitListCreateView(generics.ListCreateAPIView):
    """GET: 접수팀 대기/완료 리스트 / POST: 안내팀 방문등록(등록번호 자동 발급)"""

    def get_serializer_class(self):
        if self.request.method == 'POST':
            return VisitCreateSerializer
        return VisitIntakeListSerializer

    def get_permissions(self):
        if self.request.method == 'POST':
            return [IsInfoOrReceptionTeam()]
        return [IsReceptionTeam()]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return Visit.objects.none()

        qs = (
            Visit.objects.filter(mission=mission)
            .select_related('patient')
            .prefetch_related('visit_departments__user__primary_department')
        )

        status_param = self.request.query_params.get('status')
        today = timezone.localdate()

        if status_param == 'waiting_vitals':
            # 접수 대기 = 오늘 방문 중 주호소가 아직 비어 있는 환자 (등록번호 순)
            return qs.filter(visit_date=today, chief_complaint='').order_by('reg_no')

        if status_param == 'intake_done':
            # 접수 완료 = 주호소가 입력된 환자 (등록번호 큰 순 = 최근 등록한 환자가 위)
            return qs.filter(visit_date=today).exclude(chief_complaint='').order_by('-reg_no')

        return qs.order_by('reg_no')

    def create(self, request, *args, **kwargs):
        mission = get_current_mission(request.user)
        if mission is None:
            return Response({'detail': '진행중인 미션이 없습니다.'}, status=400)

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        today = timezone.localdate()
        with transaction.atomic():
            last = (
                Visit.objects.select_for_update()
                .filter(mission=mission, visit_date=today)
                .order_by('-reg_no')
                .first()
            )
            next_reg_no = (last.reg_no + 1) if last else 1
            visit = serializer.save(mission=mission, visit_date=today, reg_no=next_reg_no)

        return Response(VisitCreateSerializer(visit).data, status=status.HTTP_201_CREATED)


class VisitVitalsUpdateView(generics.RetrieveUpdateAPIView):
    """접수팀·진료팀 공용 - 접수 기록 조회 + vitals/병력 입력·수정"""
    queryset = Visit.objects.select_related('patient').prefetch_related('visit_departments__user__primary_department')
    permission_classes = [IsReceptionOrClinicalTeam]

    def get_serializer_class(self):
        if self.request.method in ('PATCH', 'PUT'):
            return VisitVitalsSerializer
        return VisitIntakeDetailSerializer


# =====================================================
# 의사 배정 (접수팀 배정 · 진료팀 전과/진료 완료)
# =====================================================

class DoctorWaitCountsView(APIView):
    """이번 미션의 진료팀 의사 전원 + 각자의 오늘 대기 인원 (대기 0명 포함) - 안내·접수팀 번호표, 진료팀 전과 모달"""
    permission_classes = [IsInfoOrReceptionOrClinicalTeam]

    def get(self, request):
        mission = get_current_mission(request.user)
        if mission is None:
            return Response([])

        doctors = MissionMembership.objects.filter(
            mission=mission, role__name='진료팀'
        ).select_related('user', 'user__primary_department')

        counts = dict(
            VisitDepartment.objects.filter(
                visit__mission=mission, visit__visit_date=timezone.localdate(), is_done=False
            )
            .values('user_id')
            .annotate(c=Count('id'))
            .values_list('user_id', 'c')
        )

        return Response([
            {
                'doctor_id': m.user_id,
                'doctor_name': m.user.name or m.user.username,
                'department_code': m.user.primary_department.name if m.user.primary_department else None,
                'waiting_count': counts.get(m.user_id, 0),
            }
            for m in doctors
        ])


class VisitDepartmentListCreateView(generics.ListCreateAPIView):
    """
    GET: 진료팀 내 배정 목록 (오늘만)
        ?is_done=false → 등록번호 순 / ?is_done=true → 완료 시각 최신순
    POST: 접수팀 배정 + 진료팀 전과(추가 배정) 공용, 배정한 사람(assigned_by) 기록
    """

    def get_serializer_class(self):
        if self.request.method == 'POST':
            return VisitDepartmentCreateSerializer
        return VisitDepartmentListSerializer

    def get_permissions(self):
        if self.request.method == 'POST':
            return [IsReceptionOrClinicalTeam()]
        return [IsClinicalTeam()]

    def get_queryset(self):
        qs = (
            VisitDepartment.objects.filter(user=self.request.user, visit__visit_date=timezone.localdate())
            .select_related('visit__patient')
        )
        is_done = self.request.query_params.get('is_done', '').lower()
        if is_done == 'true':
            # 완료 시각이 없는 옛 기록은 맨 아래
            return qs.filter(is_done=True).order_by(F('done_at').desc(nulls_last=True), '-visit__reg_no')
        if is_done:
            qs = qs.filter(is_done=False)
        return qs.order_by('visit__reg_no')

    def perform_create(self, serializer):
        if not can_add_assignment(self.request.user, serializer.validated_data['visit']):
            raise PermissionDenied('본인이 진료 중(완료 전)인 환자에게만 다른 의사를 추가 배정할 수 있습니다.')
        serializer.save(assigned_by=self.request.user)


class VisitDepartmentDetailView(generics.RetrieveUpdateDestroyAPIView):
    """
    GET/PATCH: 진료 상세 조회 · 진료 완료/완료 취소 (본인 배정만)
    DELETE: 의사 배정 취소 (접수팀은 전부, 진료팀은 본인이 한 배정만 / 진료 전인 배정만)
    """
    queryset = (
        VisitDepartment.objects.select_related('visit__patient')
        .prefetch_related('visit__visit_departments__user__primary_department')
    )

    def get_permissions(self):
        if self.request.method == 'DELETE':
            return [IsReceptionOrClinicalTeam(), CanCancelAssignment()]
        return [IsClinicalTeam(), IsAssignedDoctor()]

    def get_serializer_class(self):
        if self.request.method in ('PATCH', 'PUT'):
            return VisitDepartmentDoneSerializer
        return VisitDepartmentDetailSerializer

    def perform_destroy(self, instance):
        if instance.is_done:
            raise ValidationError({'detail': '이미 진료가 완료된 배정은 취소할 수 없습니다.'})
        if instance.prescriptions.exists():
            raise ValidationError({'detail': '이미 처방이 작성된 배정은 취소할 수 없습니다.'})
        instance.delete()


# =====================================================
# 진료팀 - 조회용 마스터 / 약 검색
# =====================================================

class DepartmentListView(generics.ListAPIView):
    """진료과 목록 - 처방 작성 시 선택지"""
    queryset = Department.objects.all().order_by('name')
    serializer_class = DepartmentSerializer
    permission_classes = [IsClinicalTeam]


class DrugCategory1ListView(generics.ListAPIView):
    queryset = DrugCategory1.objects.all().order_by('name')
    serializer_class = DrugCategory1ReadSerializer
    permission_classes = [IsClinicalOrPharmacyTeam]


class DrugCategory2ListView(generics.ListAPIView):
    queryset = DrugCategory2.objects.all().order_by('name')
    serializer_class = DrugCategory2ReadSerializer
    permission_classes = [IsClinicalOrPharmacyTeam]


class DrugSearchView(generics.ListAPIView):
    """진료팀 처방약 검색 - 현재 미션의 MissionStock 기준 (?search=&cat1=&cat2=)"""
    serializer_class = DrugSearchSerializer
    permission_classes = [IsClinicalTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return MissionStock.objects.none()

        qs = MissionStock.objects.filter(mission=mission).select_related('drugbatch__drug')

        cat1 = self.request.query_params.get('cat1')
        cat2 = self.request.query_params.get('cat2')
        search = self.request.query_params.get('search')

        if cat1:
            qs = qs.filter(drugbatch__drug__cat1_id=cat1)
        if cat2:
            qs = qs.filter(drugbatch__drug__cat2_id=cat2)
        if search:
            qs = qs.filter(
                Q(drugbatch__drug__name__icontains=search) |
                Q(drugbatch__drug__ingredient__icontains=search)
            )
        return qs


# =====================================================
# 진료팀 - 처방 작성·조회·수정
# =====================================================

def check_prescription_editable(prescription):
    """진료 완료된 배정의 처방이나 약국에서 이미 수령 처리된 처방은 진료팀이 고칠 수 없다"""
    if prescription.visit_department.is_done:
        raise ValidationError({'detail': '진료 완료된 처방은 수정할 수 없습니다. [완료 취소] 후 수정하세요.'})
    if prescription.is_dispensed:
        raise ValidationError({'detail': '약국에서 이미 수령 처리된 처방은 수정할 수 없습니다.'})


class PrescriptionListCreateView(generics.ListCreateAPIView):
    """
    GET ?visit_department=<id>: 내 배정 건의 처방 목록 (본인 배정만)
    GET ?visit=<id>: 같은 환자를 본 다른 의사의 처방 - 진료 완료된 배정만, 그 환자에게 배정된 의사만 (중복 처방 확인용)
    POST: 새 처방 작성 (본인 배정, 진료 완료 전만)
    """
    permission_classes = [IsClinicalTeam]

    def get_serializer_class(self):
        if self.request.method == 'POST':
            return PrescriptionCreateSerializer
        return PrescriptionListSerializer

    def get_queryset(self):
        user = self.request.user
        qs = Prescription.objects.select_related('department').prefetch_related('items__drug__cat1').order_by('id')

        visit_id = self.request.query_params.get('visit')
        if visit_id:
            if not is_assigned_to_visit(user, visit_id):
                raise PermissionDenied('본인에게 배정된 환자의 처방만 볼 수 있습니다.')
            return qs.filter(visit_department__visit_id=visit_id, visit_department__is_done=True)

        visit_department_id = self.request.query_params.get('visit_department')
        if not visit_department_id:
            return Prescription.objects.none()
        visit_department = get_object_or_404(VisitDepartment, pk=visit_department_id)
        if not owns_visit_department(user, visit_department):
            raise PermissionDenied('본인 배정의 처방만 볼 수 있습니다.')
        return qs.filter(visit_department=visit_department)

    def perform_create(self, serializer):
        visit_department = serializer.validated_data['visit_department']
        if not owns_visit_department(self.request.user, visit_department):
            raise PermissionDenied('본인에게 배정된 환자에게만 처방을 작성할 수 있습니다.')
        if visit_department.is_done:
            raise ValidationError({'detail': '진료 완료된 환자에게는 처방을 추가할 수 없습니다. [완료 취소] 후 작성하세요.'})
        serializer.save()


class PrescriptionDetailView(generics.UpdateAPIView, generics.DestroyAPIView):
    """진료팀 - 처방의 진료과·진료내용 수정 / 처방 통째로 삭제(처방약도 같이 삭제됨)"""
    queryset = Prescription.objects.select_related('visit_department')
    serializer_class = PrescriptionUpdateSerializer
    permission_classes = [IsClinicalTeam, IsPrescriptionOwner]

    def perform_update(self, serializer):
        check_prescription_editable(serializer.instance)
        serializer.save()

    def perform_destroy(self, instance):
        check_prescription_editable(instance)
        instance.delete()


class PrescriptionDrugCreateView(generics.CreateAPIView):
    """진료팀 - 처방에 약 추가 (본인 처방, 수정 가능한 상태일 때만)"""
    queryset = PrescriptionDrug.objects.all()
    serializer_class = PrescriptionDrugCreateSerializer
    permission_classes = [IsClinicalTeam]

    def perform_create(self, serializer):
        prescription = serializer.validated_data['prescription']
        if not owns_visit_department(self.request.user, prescription.visit_department):
            raise PermissionDenied('본인이 작성한 처방에만 약을 추가할 수 있습니다.')
        check_prescription_editable(prescription)
        serializer.save()


class PrescriptionDrugClinicalUpdateView(generics.UpdateAPIView, generics.DestroyAPIView):
    """진료팀 - 처방약 수정(1회량×횟수×일수가 있으면 수량 재계산됨) / 삭제"""
    queryset = PrescriptionDrug.objects.select_related('prescription__visit_department')
    serializer_class = PrescriptionDrugClinicalUpdateSerializer
    permission_classes = [IsClinicalTeam, IsPrescriptionOwner]

    def perform_update(self, serializer):
        check_prescription_editable(serializer.instance.prescription)
        serializer.save()

    def perform_destroy(self, instance):
        check_prescription_editable(instance.prescription)
        instance.delete()


# =====================================================
# 약국팀
# =====================================================
# SQLite는 select_for_update()를 무시한다(아무 잠금도 걸지 않음).
# 그래서 수령·수령 취소는 "조건부 UPDATE(예: is_dispensed=False인 것만) 후 바뀐 행 수 확인"으로
# 두 기기에서 동시에 눌러도 재고가 두 번 빠지거나 두 번 돌아오지 않게 한다.

def get_pharmacy_visit(user, visit_id):
    """약국팀이 조제·수령·수령 취소할 방문 - 현재 미션의 오늘 방문만 (아니면 404)"""
    mission = get_current_mission(user)
    return get_object_or_404(Visit, pk=visit_id, mission=mission, visit_date=timezone.localdate())


def mission_stock_max(mission):
    """{약 id: 이번 미션(정산 전) 배치 중 가장 많이 남은 잔량} - 조제지·목록의 '재고 확인' 표시용"""
    return dict(
        MissionStock.objects.filter(mission=mission, is_settled=False)
        .values('drugbatch__drug_id')
        .annotate(best=Max('remaining_qty'))
        .values_list('drugbatch__drug_id', 'best')
    )


class MissionStockListView(generics.ListAPIView):
    """약국팀 재고 조회 - 현재 미션의 MissionStock, 약 이름·유통기한 순 (?search= 약 이름·성분)"""
    serializer_class = MissionStockSerializer
    permission_classes = [IsPharmacyTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return MissionStock.objects.none()

        qs = (
            MissionStock.objects.filter(mission=mission)
            .select_related('drugbatch__drug')
            .order_by('drugbatch__drug__name', 'drugbatch__expiry_date', 'id')
        )
        search = self.request.query_params.get('search')
        if search:
            qs = qs.filter(
                Q(drugbatch__drug__name__icontains=search) |
                Q(drugbatch__drug__ingredient__icontains=search)
            )
        return qs


class PharmacyStatsView(APIView):
    """
    약국 통계 - 수령 처리된 약만 센다.
      ?period=day&date=YYYY-MM-DD (기본 오늘) / ?period=mission (미션 시작 ~ 오늘)
    summary: 고른 기간의 수령 환자 수·처방 건수·사용한 약 종수·환자당 평균 처방약 수
    drugs:   고른 기간의 약별 사용량 (많이 쓴 순)
    runway:  재고 소진 예상 - 기간과 상관없이 미션 기준.
             하루 평균 = 미션 사용량 ÷ 진료한 날 수(수령 처리가 있던 날, 오늘 포함), 예상 일수 = 남은 재고 ÷ 하루 평균.
             예상 일수가 미션 남은 일수(오늘 포함)보다 적으면 runs_out = True (미션 중 소진).
    """
    permission_classes = [IsPharmacyTeam]

    def get(self, request):
        mission = get_current_mission(request.user)
        if mission is None:
            raise ValidationError({'detail': '진행중인 미션이 없습니다.'})

        today = timezone.localdate()
        period = request.query_params.get('period', 'day')
        if period not in ('day', 'mission'):
            raise ValidationError({'detail': 'period는 day 또는 mission이어야 합니다.'})

        mission_items = PrescriptionDrug.objects.filter(
            prescription__visit_department__visit__mission=mission, prescription__is_dispensed=True,
        )
        mission_rx = Prescription.objects.filter(visit_department__visit__mission=mission, is_dispensed=True)

        if period == 'day':
            date_param = request.query_params.get('date')
            try:
                target_date = parse_date(date_param) if date_param else today
            except ValueError:  # 형식은 맞지만 없는 날짜 (예: 2026-13-01)
                target_date = None
            if target_date is None:
                raise ValidationError({'detail': '날짜 형식이 올바르지 않습니다. (예: 2026-10-15)'})
            period_items = mission_items.filter(prescription__visit_department__visit__visit_date=target_date)
            period_rx = mission_rx.filter(visit_department__visit__visit_date=target_date)
            period_info = {'period': 'day', 'date': target_date}
        else:
            period_items, period_rx = mission_items, mission_rx
            period_info = {'period': 'mission', 'start_date': mission.start_date, 'end_date': today}

        # ----- 고른 기간: 요약 + 약별 사용량 -----
        drugs = list(
            period_items.values('drug_id', 'drug__name')
            .annotate(total_quantity=Sum('quantity'))
            .order_by('-total_quantity', 'drug__name')
        )
        patients = period_rx.values('visit_department__visit_id').distinct().count()
        item_count = period_items.count()
        summary = {
            'patients': patients,
            'prescriptions': period_rx.count(),
            'drug_kinds': len(drugs),
            'avg_items_per_patient': round(item_count / patients, 1) if patients else 0,
        }

        # ----- 미션 기준: 재고 소진 예상 -----
        days_worked = mission_rx.values('visit_department__visit__visit_date').distinct().count()
        mission_days_left = max((mission.end_date - today).days + 1, 0)
        used = mission_items.values('drug_id', 'drug__name').annotate(total=Sum('quantity'))
        remaining = dict(
            MissionStock.objects.filter(mission=mission, is_settled=False)
            .values('drugbatch__drug_id')
            .annotate(total=Sum('remaining_qty'))
            .values_list('drugbatch__drug_id', 'total')
        )
        runway = []
        for u in used:
            if not u['total'] or not days_worked:
                continue
            daily_avg = u['total'] / days_worked
            left = remaining.get(u['drug_id'], 0)
            days_left = left / daily_avg
            runway.append({
                'drug_id': u['drug_id'],
                'drug_name': u['drug__name'],
                'remaining_qty': left,
                'daily_avg': round(daily_avg, 1),
                'days_left': round(days_left, 1),
                'runs_out': days_left < mission_days_left,
            })
        runway.sort(key=lambda r: (r['days_left'], r['drug_name']))

        return Response({
            **period_info,
            'summary': summary,
            'drugs': [
                {'drug_id': d['drug_id'], 'drug_name': d['drug__name'], 'total_quantity': d['total_quantity']}
                for d in drugs
            ],
            'days_worked': days_worked,
            'mission_days_left': mission_days_left,
            'runway': runway,
        })


class PharmacyQueueView(generics.ListAPIView):
    """
    조제 대기 - 환자 단위, 등록번호 순.
    오늘 방문 중 배정된 모든 진료가 끝났고(VisitDepartment 전부 is_done) 미수령 처방이 있는 방문만.
    """
    serializer_class = PharmacyVisitSerializer
    permission_classes = [IsPharmacyTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return Visit.objects.none()

        return (
            Visit.objects.filter(
                mission=mission,
                visit_date=timezone.localdate(),
                visit_departments__prescriptions__is_dispensed=False,
            )
            .exclude(visit_departments__is_done=False)
            .distinct()
            .select_related('patient')
            .order_by('reg_no')
        )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        mission = get_current_mission(self.request.user)
        context['stock_max'] = mission_stock_max(mission) if mission else {}
        return context


class PrintClaimView(APIView):
    """
    조제지 자동 출력 - body {"ids": [방문 id, ...]} 중 아직 출력하지 않은 것만 '출력함'으로 바꾸고 그 id만 돌려준다.
    자동 출력을 켠 기기가 둘이어도 먼저 가져간 쪽만 출력하게 된다.
    """
    permission_classes = [IsPharmacyTeam]

    def post(self, request):
        ids = request.data.get('ids', [])
        if not isinstance(ids, list) or not all(isinstance(i, int) for i in ids):
            raise ValidationError({'detail': 'ids는 방문 번호 목록이어야 합니다.'})
        mission = get_current_mission(request.user)
        if mission is None or not ids:
            return Response({'claimed': []})

        # transaction_mode IMMEDIATE라 이 블록은 다른 쓰기 요청과 겹치지 않는다
        with transaction.atomic():
            claimed = list(
                Visit.objects.filter(
                    id__in=ids, mission=mission, visit_date=timezone.localdate(), slip_printed_at__isnull=True,
                ).values_list('id', flat=True)
            )
            Visit.objects.filter(id__in=claimed).update(slip_printed_at=timezone.now())
        return Response({'claimed': claimed})


class PharmacyDoneView(generics.ListAPIView):
    """수령 완료 - 오늘 수령 처리된 처방이 있는 방문, 수령 시각 최신순 (수령된 처방만 담김)"""
    serializer_class = PharmacyVisitSerializer
    permission_classes = [IsPharmacyTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return Visit.objects.none()

        # 같은 조인에서 filter → annotate 하므로 Max는 수령된 처방의 시각만 본다
        return (
            Visit.objects.filter(
                mission=mission,
                visit_date=timezone.localdate(),
                visit_departments__prescriptions__is_dispensed=True,
            )
            .annotate(last_dispensed_at=Max('visit_departments__prescriptions__dispensed_at'))
            .select_related('patient')
            .order_by(F('last_dispensed_at').desc(nulls_last=True), '-reg_no')
        )

    def get_serializer_context(self):
        context = super().get_serializer_context()
        context['dispensed'] = True
        return context


class DispenseOptionsView(APIView):
    """조제 화면 - 환자의 미수령 처방 전부 + 처방약마다 고를 수 있는 배치(이번 미션, 정산 전, 유통기한 순)"""
    permission_classes = [IsPharmacyTeam]

    def get(self, request, visit_id):
        visit = get_pharmacy_visit(request.user, visit_id)
        data = PharmacyVisitSerializer(visit, context={'stock_max': mission_stock_max(visit.mission)}).data

        drug_ids = {item['drug'] for p in data['prescriptions'] for item in p['items']}
        stocks = (
            MissionStock.objects.filter(mission=visit.mission, drugbatch__drug_id__in=drug_ids, is_settled=False)
            .select_related('drugbatch')
            .order_by('drugbatch__expiry_date', 'id')
        )
        batches_by_drug = defaultdict(list)
        for stock in stocks:
            batches_by_drug[stock.drugbatch.drug_id].append({
                'mission_stock_id': stock.id,
                'expiry_date': stock.drugbatch.expiry_date,
                'source': stock.drugbatch.get_source_display(),
                'remaining_qty': stock.remaining_qty,
            })

        for prescription in data['prescriptions']:
            for item in prescription['items']:
                item['available_batches'] = batches_by_drug.get(item['drug'], [])
        return Response(data)


class DispenseView(APIView):
    """
    수령 처리 - 환자 단위 일괄. body: {"items": [{"prescription_drug": id, "mission_stock": id}, ...]}
    미수령 처방약은 전부 배치를 골라야 한다. 약 없는 처방(기도만 하는 경우)은 items 없이 수령 처리된다.
    수량 0인 약이 있으면 막는다 - 재고가 없어 약을 바꾸거나 빼야 하면 의사가 [완료 취소] 후 수정한다.
    """
    permission_classes = [IsPharmacyTeam]

    def post(self, request, visit_id):
        visit = get_pharmacy_visit(request.user, visit_id)
        if visit.visit_departments.filter(is_done=False).exists():
            raise ValidationError({'detail': '아직 진료가 끝나지 않은 의사가 있어 수령 처리할 수 없습니다.'})

        prescription_ids = list(
            Prescription.objects.filter(visit_department__visit=visit, is_dispensed=False).values_list('id', flat=True)
        )
        if not prescription_ids:
            raise ValidationError({'detail': '수령 처리할 처방이 없습니다. 이미 수령 처리되었을 수 있습니다.'})

        drugs = PrescriptionDrug.objects.filter(prescription_id__in=prescription_ids).select_related('drug').in_bulk()
        zero = [item.drug.name for item in drugs.values() if item.quantity == 0]
        if zero:
            raise ValidationError({
                'detail': f'수량이 0인 약이 있습니다: {", ".join(zero)}. 의사에게 [완료 취소] 후 처방을 고쳐 달라고 요청하세요.'
            })

        # 요청 항목 확인: {처방약 id: 배치 id}
        entries = request.data.get('items', [])
        if not isinstance(entries, list):
            raise ValidationError({'detail': 'items는 목록이어야 합니다.'})
        chosen = {}
        for entry in entries:
            try:
                drug_item_id = int(entry['prescription_drug'])
                stock_id = int(entry['mission_stock'])
            except (TypeError, KeyError, ValueError):
                raise ValidationError({'detail': '처방약과 배치 번호를 확인해 주세요.'})
            if drug_item_id not in drugs:
                raise ValidationError({'detail': '이 환자의 수령 대기 처방약이 아닌 항목이 있습니다. 새로고침 후 다시 시도하세요.'})
            if drug_item_id in chosen:
                raise ValidationError({'detail': f'{drugs[drug_item_id].drug.name}이(가) 두 번 들어 있습니다.'})
            chosen[drug_item_id] = stock_id

        missing = [item for pk, item in drugs.items() if pk not in chosen]
        if missing:
            names = ', '.join(item.drug.name for item in missing)
            raise ValidationError({'detail': f'배치를 고르지 않은 약이 있습니다: {names}'})

        # 배치 확인 + 배치별로 뺄 양 합산 (두 의사가 같은 약을 처방하면 한 배치에서 두 번 뺄 수 있다)
        stocks = (
            MissionStock.objects.filter(mission=visit.mission)
            .select_related('drugbatch__drug')
            .in_bulk(set(chosen.values()))
        )
        demand = defaultdict(int)
        for drug_item_id, stock_id in chosen.items():
            item = drugs[drug_item_id]
            stock = stocks.get(stock_id)
            if stock is None or stock.drugbatch.drug_id != item.drug_id:
                raise ValidationError({'detail': f'{item.drug.name}: 고른 배치가 이 약의 이번 미션 재고가 아닙니다.'})
            if stock.is_settled:
                raise ValidationError({'detail': f'{item.drug.name}: 이미 정산이 끝난 배치입니다.'})
            demand[stock_id] += item.quantity

        with transaction.atomic():
            # 먼저 처방을 수령 상태로 바꾼다. 다른 기기가 먼저 처리했으면 바뀐 수가 모자라므로 전부 되돌린다.
            updated = Prescription.objects.filter(id__in=prescription_ids, is_dispensed=False).update(
                is_dispensed=True, dispensed_at=timezone.now(),
            )
            if updated != len(prescription_ids):
                raise ValidationError({'detail': '다른 기기에서 이미 수령 처리했습니다. 목록을 새로고침하세요.'})

            for stock_id, qty in demand.items():
                ok =MissionStock.objects.filter(id=stock_id, remaining_qty__gte=qty).update(
                    remaining_qty=F('remaining_qty') - qty,
                )
                if not ok:
                    stock = stocks[stock_id]
                    stock.refresh_from_db(fields=['remaining_qty'])
                    raise ValidationError({
                        'detail': f'{stock.drugbatch.drug.name} (유통기한 {stock.drugbatch.expiry_date}) 재고가 부족합니다. '
                                  f'(잔량 {stock.remaining_qty}, 필요 {qty})'
                    })

            for drug_item_id, stock_id in chosen.items():
                PrescriptionDrug.objects.filter(id=drug_item_id).update(dispensed_stock_id=stock_id)

        return Response({'detail': '수령 처리가 완료되었습니다.'})


class UndispenseView(APIView):
    """수령 취소 - 이 방문의 수령된 처방을 전부 조제 대기로 되돌리고, 조제할 때 뺀 배치에 재고를 돌려준다 (오늘 방문만)"""
    permission_classes = [IsPharmacyTeam]

    def post(self, request, visit_id):
        visit = get_pharmacy_visit(request.user, visit_id)
        prescription_ids = list(
            Prescription.objects.filter(visit_department__visit=visit, is_dispensed=True).values_list('id', flat=True)
        )
        if not prescription_ids:
            raise ValidationError({'detail': '수령 처리된 처방이 없습니다. 이미 취소되었을 수 있습니다.'})

        items = PrescriptionDrug.objects.filter(prescription_id__in=prescription_ids).select_related('drug', 'dispensed_stock')
        restore = defaultdict(int)
        for item in items:
            if item.dispensed_stock is None:
                raise ValidationError({'detail': f'{item.drug.name}: 조제한 배치 기록이 없어 수령을 취소할 수 없습니다.'})
            if item.dispensed_stock.is_settled:
                raise ValidationError({'detail': f'{item.drug.name}: 이미 정산이 끝난 배치라 수령을 취소할 수 없습니다.'})
            restore[item.dispensed_stock_id] += item.quantity

        with transaction.atomic():
            updated = Prescription.objects.filter(id__in=prescription_ids, is_dispensed=True).update(
                is_dispensed=False, dispensed_at=None,
            )
            if updated != len(prescription_ids):
                raise ValidationError({'detail': '다른 기기에서 이미 수령을 취소했습니다. 목록을 새로고침하세요.'})

            for stock_id, qty in restore.items():
                MissionStock.objects.filter(id=stock_id).update(remaining_qty=F('remaining_qty') + qty)
            PrescriptionDrug.objects.filter(prescription_id__in=prescription_ids).update(dispensed_stock=None)

        return Response({'detail': '수령을 취소했습니다. 조제 대기로 돌아갑니다.'})


class PrescriptionDrugUpdateView(generics.UpdateAPIView):
    """
    약국팀 - 재고가 모자랄 때 처방약 수량만 수정 (1 이상, 재계산하지 않음).
    이번 미션 오늘 방문의, 진료 완료되고 아직 수령 전인 처방약만.
    """
    serializer_class = PrescriptionDrugUpdateSerializer
    permission_classes = [IsPharmacyTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        return PrescriptionDrug.objects.filter(
            prescription__visit_department__visit__mission=mission,
            prescription__visit_department__visit__visit_date=timezone.localdate(),
        ).select_related('prescription__visit_department')

    def perform_update(self, serializer):
        prescription = serializer.instance.prescription
        if prescription.is_dispensed:
            raise ValidationError({'detail': '이미 수령 처리된 처방약은 수정할 수 없습니다. [수령 취소] 후 수정하세요.'})
        if not prescription.visit_department.is_done:
            raise ValidationError({'detail': '진료가 끝나지 않은 처방약은 수정할 수 없습니다.'})
        serializer.save()
