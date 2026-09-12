from django.contrib import admin
from .models import Mission, Role, MissionMembership, Department, DrugCategory1, DrugCategory2, Patient, Visit, VisitDepartment
from .models import Drug, DrugBatch, MissionStock, Prescription, PrescriptionDrug

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
    

@admin.register(Drug)
class DrugAdmin(admin.ModelAdmin):
    list_display = ('name', 'cat1', 'cat2', 'ingredient')
    list_filter = ('cat1', 'cat2')
    search_fields = ('name', 'ingredient')


@admin.register(DrugBatch)
class DrugBatchAdmin(admin.ModelAdmin):
    list_display = ('drug', 'source', 'received_date', 'expiry_date', 'total_qty', 'remaining_qty')
    list_filter = ('source',)


@admin.register(MissionStock)
class MissionStockAdmin(admin.ModelAdmin):
    list_display = ('drugbatch', 'mission', 'allocated_qty', 'remaining_qty', 'donated_qty', 'is_settled')
    list_filter = ('mission', 'is_settled')


@admin.register(Prescription)
class PrescriptionAdmin(admin.ModelAdmin):
    list_display = ('visit_department', 'department', 'is_dispensed')
    list_filter = ('department', 'is_dispensed')


@admin.register(PrescriptionDrug)
class PrescriptionDrugAdmin(admin.ModelAdmin):
    list_display = ('prescription', 'drug', 'dose_per_intake', 'frequency_per_day', 'duration_days', 'quantity')