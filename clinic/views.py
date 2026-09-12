from datetime import date

from django.db import transaction
from django.db.models import Count, Q
from rest_framework import generics, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Patient, Visit, VisitDepartment
from .permissions import IsInfoTeam, IsInfoOrReceptionTeam, get_active_memberships
from .serializers import PatientSerializer, VisitCreateSerializer


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


class VisitCreateView(generics.CreateAPIView):
    serializer_class = VisitCreateSerializer
    permission_classes = [IsInfoTeam]

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