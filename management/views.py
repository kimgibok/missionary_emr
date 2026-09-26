from rest_framework import viewsets
from rest_framework.views import APIView
from rest_framework.response import Response

from clinic.models import Drug, DrugCategory1, DrugCategory2, DrugBatch, MissionStock

from .permissions import IsSuperUser
from .serializers import (
    DrugCategory1Serializer, DrugCategory2Serializer, DrugSerializer,
    DrugBatchSerializer, MissionStockSerializer,
)


class DrugCategory1ViewSet(viewsets.ModelViewSet):
    queryset = DrugCategory1.objects.all()
    serializer_class = DrugCategory1Serializer
    permission_classes = [IsSuperUser]


class DrugCategory2ViewSet(viewsets.ModelViewSet):
    queryset = DrugCategory2.objects.all()
    serializer_class = DrugCategory2Serializer
    permission_classes = [IsSuperUser]


class DrugViewSet(viewsets.ModelViewSet):
    queryset = Drug.objects.all()
    serializer_class = DrugSerializer
    permission_classes = [IsSuperUser]


class DrugBatchViewSet(viewsets.ModelViewSet):
    queryset = DrugBatch.objects.all()
    serializer_class = DrugBatchSerializer
    permission_classes = [IsSuperUser]


class MissionStockViewSet(viewsets.ModelViewSet):
    queryset = MissionStock.objects.all()
    serializer_class = MissionStockSerializer
    permission_classes = [IsSuperUser]
    

from datetime import date

from django.db.models import Case, When, Value, IntegerField
from rest_framework.generics import ListAPIView

from clinic.models import Mission
from .serializers import MissionSerializer


class MissionListView(ListAPIView):
    """관리자 - 미션 탭 목록. 진행중인 미션 먼저, 이후 최신순"""
    serializer_class = MissionSerializer
    permission_classes = [IsSuperUser]

    def get_queryset(self):
        today = date.today()
        return Mission.objects.annotate(
            is_active=Case(
                When(start_date__lte=today, end_date__gte=today, then=Value(0)),
                default=Value(1),
                output_field=IntegerField(),
            )
        ).order_by('is_active', '-start_date')
        
from django.utils import timezone
from clinic.models import Visit, Prescription


class VisitStatsView(APIView):
    permission_classes = [IsSuperUser]

    def get(self, request):
        mission_id = request.query_params.get('mission')
        if not mission_id:
            return Response({'detail': 'mission 쿼리 파라미터가 필요합니다.'}, status=400)

        prescriptions = Prescription.objects.filter(
            visit_department__visit__mission_id=mission_id
        ).select_related('department', 'visit_department__visit__patient')

        stats = {}
        for p in prescriptions:
            visit = p.visit_department.visit
            patient = visit.patient
            age = visit.visit_date.year - patient.birth_year
            age_group = '소아' if age <= 19 else '성인'
            dept_name = p.department.name

            key = (age_group, patient.sex, dept_name)
            stats[key] = stats.get(key, 0) + 1

        result = [
            {'age_group': k[0], 'sex': k[1], 'department': k[2], 'count': v}
            for k, v in stats.items()
        ]
        return Response(result)
    
    
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from django.db import transaction


class MissionStockViewSet(viewsets.ModelViewSet):
    queryset = MissionStock.objects.all()
    serializer_class = MissionStockSerializer
    permission_classes = [IsSuperUser]

    @action(detail=True, methods=['post'])
    def settle(self, request, pk=None):
        mission_stock = self.get_object()
        donated_qty = request.data.get('donated_qty', 0)

        if donated_qty > mission_stock.remaining_qty:
            raise ValidationError({'detail': '기부량이 현재 잔량보다 많습니다.'})

        returned_qty = mission_stock.remaining_qty - donated_qty

        with transaction.atomic():
            drugbatch = DrugBatch.objects.select_for_update().get(id=mission_stock.drugbatch_id)
            drugbatch.remaining_qty += returned_qty
            drugbatch.save()

            mission_stock.donated_qty = donated_qty
            mission_stock.is_settled = True
            mission_stock.save()

        return Response({
            'donated_qty': donated_qty,
            'returned_qty': returned_qty,
            'drugbatch_remaining_qty': drugbatch.remaining_qty,
        })



## 엑셀 export      
from io import BytesIO

from django.http import HttpResponse
from openpyxl import Workbook

from clinic.models import DrugCategory1


class MissionStockExportView(APIView):
    permission_classes = [IsSuperUser]

    def get(self, request):
        mission_id = request.query_params.get('mission')
        if not mission_id:
            return Response({'detail': 'mission 쿼리 파라미터가 필요합니다.'}, status=400)

        wb = Workbook()
        wb.remove(wb.active)  # 기본으로 딸려오는 빈 시트 제거

        for cat1 in DrugCategory1.objects.all():
            stocks = MissionStock.objects.filter(
                mission_id=mission_id, drugbatch__drug__cat1=cat1
            ).select_related('drugbatch__drug')

            if not stocks.exists():
                continue

            ws = wb.create_sheet(title=cat1.name[:31])  # 시트명 31자 제한
            ws.append(['약품명', '성분', '유통기한', '배분량', '잔량', '기부량', '정산완료'])

            for s in stocks:
                ws.append([
                    s.drugbatch.drug.name,
                    s.drugbatch.drug.ingredient,
                    str(s.drugbatch.expiry_date),
                    s.allocated_qty,
                    s.remaining_qty,
                    s.donated_qty,
                    '완료' if s.is_settled else '',
                ])

        buffer = BytesIO()
        wb.save(buffer)
        buffer.seek(0)

        response = HttpResponse(
            buffer.read(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
        response['Content-Disposition'] = f'attachment; filename="mission_{mission_id}_drugs.xlsx"'
        return response