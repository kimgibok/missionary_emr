"""
URL configuration for config project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/5.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""
from django.contrib import admin
from django.urls import path, include
from django.views.generic import TemplateView

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/v1/auth/', include('accounts.urls')),
    path('api/v1/', include('clinic.urls')),
    path('api/v1/manage/', include('management.urls')),
    
    path('', TemplateView.as_view(template_name='login.html'), name='login-page'),
    path('select-mission/', TemplateView.as_view(template_name='select_mission.html'), name='select-mission-page'),
    path('no-mission/', TemplateView.as_view(template_name='no_mission.html'), name='no-mission-page'),
    path('info/', TemplateView.as_view(template_name='roles/info.html'), name='info-page'),
    path('reception/', TemplateView.as_view(template_name='roles/reception.html'), name='reception-page'),
    path('clinical/', TemplateView.as_view(template_name='roles/clinical.html'), name='clinical-page'),
    path('pharmacy/', TemplateView.as_view(template_name='roles/pharmacy.html'), name='pharmacy-page'),
    path('manage/', TemplateView.as_view(template_name='roles/admin.html'), name='admin-page'),
]
