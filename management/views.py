from rest_framework import viewsets

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