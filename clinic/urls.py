from django.urls import path

from .views import (
    PatientListCreateView, PatientDetailView,
    VisitListCreateView, VisitVitalsUpdateView,
    VisitDepartmentCreateView, DoctorWaitCountsView,
)

urlpatterns = [
    path('patients/', PatientListCreateView.as_view(), name='patient-list-create'),
    path('patients/<int:pk>/', PatientDetailView.as_view(), name='patient-detail'),
    path('visits/', VisitListCreateView.as_view(), name='visit-list-create'),
    path('visits/<int:pk>/', VisitVitalsUpdateView.as_view(), name='visit-vitals-update'),
    path('visit-departments/', VisitDepartmentCreateView.as_view(), name='visit-department-create'),
    path('visit-departments/wait-counts/', DoctorWaitCountsView.as_view(), name='doctor-wait-counts'),
]