from django.contrib import admin
from .models import Mission, Role, MissionMembership, Department, DrugCategory1, DrugCategory2, Patient, Visit, VisitDepartment


@admin.register(Mission)
class MissionAdmin(admin.ModelAdmin):
    list_display = ('country', 'start_date', 'end_date')


@admin.register(Role)
class RoleAdmin(admin.ModelAdmin):
    list_display = ('name',)


@admin.register(MissionMembership)
class MissionMembershipAdmin(admin.ModelAdmin):
    list_display = ('user', 'mission', 'role')
    list_filter = ('mission', 'role')


@admin.register(Department)
class DepartmentAdmin(admin.ModelAdmin):
    list_display = ('name',)


@admin.register(DrugCategory1)
class DrugCategory1Admin(admin.ModelAdmin):
    list_display = ('name',)


@admin.register(DrugCategory2)
class DrugCategory2Admin(admin.ModelAdmin):
    list_display = ('name',)
    

@admin.register(Patient)
class PatientAdmin(admin.ModelAdmin):
    list_display = ('name_kr', 'name_local', 'sex', 'birth_year')
    search_fields = ('name_kr', 'name_local')


@admin.register(Visit)
class VisitAdmin(admin.ModelAdmin):
    list_display = ('patient', 'mission', 'visit_date', 'reg_no', 'is_preg')
    list_filter = ('mission', 'visit_date')


@admin.register(VisitDepartment)
class VisitDepartmentAdmin(admin.ModelAdmin):
    list_display = ('visit', 'user', 'assigned_at', 'is_done')
    list_filter = ('is_done',)