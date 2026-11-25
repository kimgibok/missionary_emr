from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    DrugCategory1ViewSet, DrugCategory2ViewSet, DrugViewSet, DrugBatchViewSet, MissionStockViewSet,
    MissionListView, VisitStatsView, DrugStatsView, MissionStockExportView, StockAdjustmentListView, SiteConfigView,
)

router = DefaultRouter()
router.register('drug-categories1', DrugCategory1ViewSet, basename='drugcategory1')
router.register('drug-categories2', DrugCategory2ViewSet, basename='drugcategory2')
router.register('drugs', DrugViewSet, basename='drug-admin')
router.register('drug-batches', DrugBatchViewSet, basename='drugbatch')
router.register('mission-stocks', MissionStockViewSet, basename='missionstock-admin')

# 고정 경로(export/ 등)는 라우터 URL(mission-stocks/<pk>/)보다 먼저 둔다
urlpatterns = [
    path('missions/', MissionListView.as_view(), name='mission-list'),
    path('visits/stats/', VisitStatsView.as_view(), name='visit-stats'),
    path('drug-stats/', DrugStatsView.as_view(), name='drug-stats'),
    path('mission-stocks/export/', MissionStockExportView.as_view(), name='mission-stock-export'),
    path('stock-adjustments/', StockAdjustmentListView.as_view(), name='stock-adjustment-list'),
    path('site-config/', SiteConfigView.as_view(), name='site-config'),
] + router.urls
