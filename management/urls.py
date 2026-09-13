from rest_framework.routers import DefaultRouter

from .views import (
    DrugCategory1ViewSet, DrugCategory2ViewSet, DrugViewSet, DrugBatchViewSet, MissionStockViewSet,
)

router = DefaultRouter()
router.register('drug-categories1', DrugCategory1ViewSet, basename='drugcategory1')
router.register('drug-categories2', DrugCategory2ViewSet, basename='drugcategory2')
router.register('drugs', DrugViewSet, basename='drug-admin')
router.register('drug-batches', DrugBatchViewSet, basename='drugbatch')
router.register('mission-stocks', MissionStockViewSet, basename='missionstock-admin')

urlpatterns = router.urls