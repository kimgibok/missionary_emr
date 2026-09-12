from datetime import date

from django.db import transaction
from django.db.models import Count, Q
from rest_framework import generics, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Patient, Visit, VisitDepartment
from .permissions import IsInfoTeam, IsReceptionTeam, IsInfoOrReceptionTeam, get_active_memberships
from .serializers import (
    PatientSerializer, VisitCreateSerializer, VisitListSerializer, VisitVitalsSerializer,
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
        return VisitListSerializer

    def get_permissions(self):
        if self.request.method == 'POST':
            return [IsInfoTeam()]
        return [IsReceptionTeam()]

    def get_queryset(self):
        mission = get_current_mission(self.request.user)
        if mission is None:
            return Visit.objects.none()

        qs = Visit.objects.filter(mission=mission).select_related('patient')

        if self.request.query_params.get('status') == 'waiting_vitals':
            qs = qs.filter(visit_date=date.today(), pr__isnull=True)

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
    permission_classes = [IsInfoOrReceptionTeam]

    def get(self, request):
        mission = get_current_mission(request.user)
        if mission is None:
            return Response([])

        counts = (
            VisitDepartment.objects.filter(visit__mission=mission, is_done=False)
            .values('user_id', 'user__name')
            .annotate(waiting_count=Count('id'))
            .order_by('user__name')
        )
        return Response([
            {'doctor_id': c['user_id'], 'doctor_name': c['user__name'], 'waiting_count': c['waiting_count']}
            for c in counts
        ])
        
    

# 의사 배정
from .permissions import IsClinicalTeam, IsReceptionOrClinicalTeam, IsInfoOrReceptionOrClinicalTeam
from .serializers import (
    VisitDepartmentListSerializer, VisitDepartmentDetailSerializer, VisitDepartmentDoneSerializer, VisitDepartmentCreateSerializer,
)

class VisitVitalsUpdateView(generics.UpdateAPIView):
    """접수팀·진료팀 공용 - vitals/병력 입력·수정"""
    queryset = Visit.objects.all()
    serializer_class = VisitVitalsSerializer
    permission_classes = [IsReceptionOrClinicalTeam]

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


class VisitDepartmentDetailView(generics.RetrieveUpdateAPIView):
    """GET: 진료 상세조회(환자+vitals+병력 nested) / PATCH: 진료완료 처리"""
    queryset = VisitDepartment.objects.select_related('visit__patient')
    permission_classes = [IsClinicalTeam]

    def get_serializer_class(self):
        if self.request.method in ('PATCH', 'PUT'):
            return VisitDepartmentDoneSerializer
        return VisitDepartmentDetailSerializer


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