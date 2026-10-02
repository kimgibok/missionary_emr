from datetime import date

from django.db import transaction
from django.db.models import Count, Q
from rest_framework import generics, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Patient, Visit, VisitDepartment, MissionMembership
from .permissions import IsInfoTeam, IsReceptionTeam, IsInfoOrReceptionTeam, get_active_memberships
from .serializers import (
    PatientSerializer, VisitCreateSerializer, VisitListSerializer, VisitVitalsSerializer, VisitIntakeListSerializer, VisitIntakeDetailSerializer,
)


def get_current_mission(user):
    """로그인한 유저의 현재 진행중인 미션 (여러 개면 일단 첫 번째로 처리)"""
    membership = get_active_memberships(user).first()
    return membership.mission if membership else None


class PatientListCreateView(generics.ListCreateAPIView):
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


class VisitListCreateView(generics.ListCreateAPIView):
    """GET: 접수팀 대기리스트 / POST: 안내팀 방문등록"""

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


class DoctorWaitCountsView(APIView):
    """이번 미션의 진료팀 의사 전원 + 각자의 대기 인원 (대기 0명인 의사도 포함)"""
    permission_classes = [IsInfoOrReceptionTeam]

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
        
    

# 의사 배정
from .permissions import IsClinicalTeam, IsReceptionOrClinicalTeam, IsInfoOrReceptionOrClinicalTeam
from .serializers import (
    VisitDepartmentListSerializer, VisitDepartmentDetailSerializer, VisitDepartmentDoneSerializer, VisitDepartmentCreateSerializer,
)

class VisitVitalsUpdateView(generics.RetrieveUpdateAPIView):
    """접수팀·진료팀 공용 - 접수 기록 조회 + vitals/병력 입력·수정"""
    queryset = Visit.objects.select_related('patient').prefetch_related('visit_departments__user__primary_department')
    permission_classes = [IsReceptionOrClinicalTeam]

    def get_serializer_class(self):
        if self.request.method in ('PATCH', 'PUT'):
            return VisitVitalsSerializer
        return VisitIntakeDetailSerializer

class PatientDetailView(generics.RetrieveUpdateAPIView):
    """환자 기본정보 조회/수정 - 안내팀·접수팀 공용"""
    queryset = Patient.objects.all()
    serializer_class = PatientSerializer
    permission_classes = [IsInfoOrReceptionOrClinicalTeam]

class VisitDepartmentListCreateView(generics.ListCreateAPIView):
    """GET: 진료팀 내 배정목록 / POST: 접수팀 배정 + 진료팀 전과(추가배정) 공용"""

    def get_serializer_class(self):
        if self.request.method == 'POST':
            return VisitDepartmentCreateSerializer
        return VisitDepartmentListSerializer

    def get_permissions(self):
        if self.request.method == 'POST':
            return [IsReceptionOrClinicalTeam()]
        return [IsClinicalTeam()]

    def get_queryset(self):
        qs = VisitDepartment.objects.filter(user=self.request.user).select_related('visit__patient')
        is_done = self.request.query_params.get('is_done')
        if is_done is not None:
            qs = qs.filter(is_done=(is_done.lower() == 'true'))
        return qs.order_by('assigned_at')


class VisitDepartmentDetailView(generics.RetrieveUpdateDestroyAPIView):
    """GET/PATCH: 진료팀 상세조회·진료완료 / DELETE: 접수팀의 의사 배정 취소"""
    queryset = VisitDepartment.objects.select_related('visit__patient')

    def get_permissions(self):
        if self.request.method == 'DELETE':
            return [IsReceptionTeam()]
        return [IsClinicalTeam()]

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


# 처방관련
from .models import Prescription, PrescriptionDrug, MissionStock
from .serializers import (
    PrescriptionCreateSerializer, PrescriptionDrugCreateSerializer, DrugSearchSerializer,
)


class PrescriptionCreateView(generics.CreateAPIView):
    queryset = Prescription.objects.all()
    serializer_class = PrescriptionCreateSerializer
    permission_classes = [IsClinicalTeam]


class PrescriptionDrugCreateView(generics.CreateAPIView):
    queryset = PrescriptionDrug.objects.all()
    serializer_class = PrescriptionDrugCreateSerializer
    permission_classes = [IsClinicalTeam]


class DrugSearchView(generics.ListAPIView):
    """진료팀 처방약 검색 - 현재 미션의 missionstock 기준"""
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
    

## 약국팀  
from django.db.models import Sum
from django.db.models.functions import TruncDate

from .models import Prescription, PrescriptionDrug, MissionStock
from .permissions import IsPharmacyTeam
from .serializers import MissionStockSerializer, PharmacyQueueSerializer, PrescriptionDrugUpdateSerializer


class MissionStockListView(generics.ListAPIView):
    """약국팀 재고조회 + 진료팀 처방약검색과 별개로, 약국팀 화면용 (동일 데이터, 시리얼라이저만 다름)"""
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
    """환자 단위 처방대기리스트 - 배정된 모든 visitdepartment가 완료되고, 미수령 처방이 있는 visit만"""
    serializer_class = PharmacyQueueSerializer
    permission_classes = [IsPharmacyTeam]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return Visit.objects.none()

        qs = Visit.objects.filter(mission=mission).exclude(visit_departments__is_done=False)
        qs = qs.filter(visit_departments__prescriptions__is_dispensed=False).distinct()
        return qs.select_related('patient')
    

## 배차 선택지  조회 + 수령처리
from rest_framework.exceptions import ValidationError


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
    """약국팀 - 조제 중 재고불일치로 약품/수량 변경 필요 시"""
    queryset = PrescriptionDrug.objects.all()
    serializer_class = PrescriptionDrugUpdateSerializer   # 이 줄만 변경
    permission_classes = [IsPharmacyTeam]