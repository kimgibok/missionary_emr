from django.urls import path

from .views import (
    PatientListCreateView, PatientDetailView,
    VisitListCreateView, VisitVitalsUpdateView,
    VisitDepartmentListCreateView, VisitDepartmentDetailView, DoctorWaitCountsView,
    PrescriptionDrugCreateView, DrugSearchView, DepartmentListView, PrescriptionListCreateView,
    PrescriptionDetailView,
)
from .views import DispenseOptionsView, DispenseView, MissionStockListView, DailyDrugStatsView, PharmacyQueueView, PrescriptionDrugUpdateView, PrescriptionDrugClinicalUpdateView

from .views import DrugCategory1ListView, DrugCategory2ListView


urlpatterns = [
    path('patients/', PatientListCreateView.as_view(), name='patient-list-create'),
    path('patients/<int:pk>/', PatientDetailView.as_view(), name='patient-detail'),
    path('visits/', VisitListCreateView.as_view(), name='visit-list-create'),
    path('visits/<int:pk>/', VisitVitalsUpdateView.as_view(), name='visit-vitals-update'),
    path('visit-departments/', VisitDepartmentListCreateView.as_view(), name='visit-department-list-create'),
    path('visit-departments/wait-counts/', DoctorWaitCountsView.as_view(), name='doctor-wait-counts'),
    path('visit-departments/<int:pk>/', VisitDepartmentDetailView.as_view(), name='visit-department-detail'),
    path('prescriptions/', PrescriptionListCreateView.as_view(), name='prescription-create'),
    path('prescriptions/<int:pk>/', PrescriptionDetailView.as_view(), name='prescription-detail'),
    path('prescription-drugs/', PrescriptionDrugCreateView.as_view(), name='prescription-drug-create'),
    path('drugs/', DrugSearchView.as_view(), name='drug-search'),
    path('mission-stocks/', MissionStockListView.as_view(), name='mission-stock-list'),
    path('prescription-drugs/daily-stats/', DailyDrugStatsView.as_view(), name='daily-drug-stats'),
    path('visits/pharmacy-queue/', PharmacyQueueView.as_view(), name='pharmacy-queue'),
    path('visits/<int:visit_id>/dispense-options/', DispenseOptionsView.as_view(), name='dispense-options'),
    path('visits/<int:visit_id>/dispense/', DispenseView.as_view(), name='dispense'),
    path('prescription-drugs/<int:pk>/', PrescriptionDrugUpdateView.as_view(), name='prescription-drug-update'),
    path('prescription-drugs/<int:pk>/clinical/', PrescriptionDrugClinicalUpdateView.as_view(), name='prescription-drug-clinical-update'),
    path('departments/', DepartmentListView.as_view(), name='department-list'),
    path('drug-categories1/', DrugCategory1ListView.as_view(), name='drug-category1-list'),
    path('drug-categories2/', DrugCategory2ListView.as_view(), name='drug-category2-list'),
]