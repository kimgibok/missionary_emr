from django.contrib import admin
from .models import Mission, Role, MissionMembership, Department, DrugCategory1, DrugCategory2


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