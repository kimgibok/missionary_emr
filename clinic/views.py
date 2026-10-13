from datetime import date

from django.db import transaction
from django.db.models import Count, F, Q, Sum
from django.shortcuts import get_object_or_404
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
    MissionStockSerializer, PharmacyQueueSerializer,
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
        today = date.today()

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

        today = date.today()
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
                visit__mission=mission, visit__visit_date=date.today(), is_done=False
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
            VisitDepartment.objects.filter(user=self.request.user, visit__visit_date=date.today())
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

class MissionStockListView(generics.ListAPIView):
    """약국팀 재고 조회 - 현재 미션의 MissionStock (?search=)"""
    serializer_class = MissionStockSerializer
    permission_classes = [IsPharmacyTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return MissionStock.objects.none()

        qs = MissionStock.objects.filter(mission=mission).select_related('drugbatch__drug')
        search = self.request.query_params.get('search')
        if search:
            qs = qs.filter(drugbatch__drug__name__icontains=search)
        return qs


class DailyDrugStatsView(APIView):
    """약국팀 일별 약품 사용 통계 (?date=YYYY-MM-DD, 기본 오늘)"""
    permission_classes = [IsPharmacyTeam]

    def get(self, request):
        mission = get_current_mission(request.user)
        if mission is None:
            return Response([])

        target_date = request.query_params.get('date', str(date.today()))

        stats = (
            PrescriptionDrug.objects.filter(
                prescription__visit_department__visit__mission=mission,
                prescription__visit_department__visit__visit_date=target_date,
            )
            .values('drug_id', 'drug__name')
            .annotate(total_quantity=Sum('quantity'))
            .order_by('-total_quantity')
        )
        return Response([
            {'drug_id': s['drug_id'], 'drug_name': s['drug__name'], 'total_quantity': s['total_quantity']}
            for s in stats
        ])


class PharmacyQueueView(generics.ListAPIView):
    """환자 단위 처방 대기 리스트 - 배정된 모든 VisitDepartment가 완료되고, 미수령 처방이 있는 방문만"""
    serializer_class = PharmacyQueueSerializer
    permission_classes = [IsPharmacyTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return Visit.objects.none()

        qs = Visit.objects.filter(mission=mission).exclude(visit_departments__is_done=False)
        qs = qs.filter(visit_departments__prescriptions__is_dispensed=False).distinct()
        return qs.select_related('patient')


class DispenseOptionsView(APIView):
    """조제 화면 진입 - 환자의 미수령 처방약 전부 + 각각 선택 가능한 배치(MissionStock) 목록"""
    permission_classes = [IsPharmacyTeam]

    def get(self, request, visit_id):
        mission = get_current_mission(request.user)
        items = PrescriptionDrug.objects.filter(
            prescription__visit_department__visit_id=visit_id,
            prescription__is_dispensed=False,
        ).select_related('drug')

        result = []
        for item in items:
            batches = MissionStock.objects.filter(
                mission=mission, drugbatch__drug=item.drug
            ).select_related('drugbatch').order_by('drugbatch__expiry_date')

            result.append({
                'prescription_drug_id': item.id,
                'drug_name': item.drug.name,
                'quantity': item.quantity,
                'available_batches': [
                    {
                        'mission_stock_id': b.id,
                        'expiry_date': b.drugbatch.expiry_date,
                        'remaining_qty': b.remaining_qty,
                    }
                    for b in batches
                ],
            })
        return Response({'items': result})


class DispenseView(APIView):
    """수령 처리 - 환자 단위 일괄, 지정 배치에서 재고 차감"""
    permission_classes = [IsPharmacyTeam]

    def post(self, request, visit_id):
        items = request.data.get('items', [])
        if not items:
            raise ValidationError({'items': '수령 처리할 항목이 없습니다.'})

        with transaction.atomic():
            for entry in items:
                prescription_drug = PrescriptionDrug.objects.select_related('prescription').get(
                    id=entry['prescription_drug']
                )
                mission_stock = MissionStock.objects.select_for_update().get(id=entry['mission_stock'])

                if mission_stock.remaining_qty < prescription_drug.quantity:
                    raise ValidationError({
                        'detail': f"{prescription_drug.drug.name} 재고가 부족합니다. "
                                  f"(잔량 {mission_stock.remaining_qty}, 필요 {prescription_drug.quantity})"
                    })

                mission_stock.remaining_qty -= prescription_drug.quantity
                mission_stock.save()

            Prescription.objects.filter(
                visit_department__visit_id=visit_id, is_dispensed=False
            ).update(is_dispensed=True)

        return Response({'detail': '수령 처리가 완료되었습니다.'})


class PrescriptionDrugUpdateView(generics.UpdateAPIView):
    """약국팀 - 조제 중 재고 불일치로 약품/수량 변경 (수량을 그대로 믿고 재계산하지 않음)"""
    queryset = PrescriptionDrug.objects.all()
    serializer_class = PrescriptionDrugUpdateSerializer
    permission_classes = [IsPharmacyTeam]
