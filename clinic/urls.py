from django.urls import path

from .views import (
    PatientListCreateView, PatientDetailView,
    VisitListCreateView, VisitVitalsUpdateView,
    VisitDepartmentListCreateView, VisitDepartmentDetailView, DoctorWaitCountsView,
    PrescriptionCreateView, PrescriptionDrugCreateView, DrugSearchView,
)
from .views import DispenseOptionsView, DispenseView, MissionStockListView, DailyDrugStatsView, PharmacyQueueView, PrescriptionDrugUpdateView

urlpatterns = [
    path('patients/', PatientListCreateView.as_view(), name='patient-list-create'),
    path('patients/<int:pk>/', PatientDetailView.as_view(), name='patient-detail'),
    path('visits/', VisitListCreateView.as_view(), name='visit-list-create'),
    path('visits/<int:pk>/', VisitVitalsUpdateView.as_view(), name='visit-vitals-update'),
    path('visit-departments/', VisitDepartmentListCreateView.as_view(), name='visit-department-list-create'),
    path('visit-departments/wait-counts/', DoctorWaitCountsView.as_view(), name='doctor-wait-counts'),
    path('visit-departments/<int:pk>/', VisitDepartmentDetailView.as_view(), name='visit-department-detail'),
    path('prescriptions/', PrescriptionCreateView.as_view(), name='prescription-create'),
    path('prescription-drugs/', PrescriptionDrugCreateView.as_view(), name='prescription-drug-create'),
    path('drugs/', DrugSearchView.as_view(), name='drug-search'),
    path('mission-stocks/', MissionStockListView.as_view(), name='mission-stock-list'),
    path('prescription-drugs/daily-stats/', DailyDrugStatsView.as_view(), name='daily-drug-stats'),
    path('visits/pharmacy-queue/', PharmacyQueueView.as_view(), name='pharmacy-queue'),
    path('visits/<int:visit_id>/dispense-options/', DispenseOptionsView.as_view(), name='dispense-options'),
    path('visits/<int:visit_id>/dispense/', DispenseView.as_view(), name='dispense'),
    path('prescription-drugs/<int:pk>/', PrescriptionDrugUpdateView.as_view(), name='prescription-drug-update'),
]