from django.urls import path

from .views import PatientListCreateView, VisitCreateView, DoctorWaitCountsView

urlpatterns = [
    path('patients/', PatientListCreateView.as_view(), name='patient-list-create'),
    path('visits/', VisitCreateView.as_view(), name='visit-create'),
    path('visit-departments/wait-counts/', DoctorWaitCountsView.as_view(), name='doctor-wait-counts'),
]