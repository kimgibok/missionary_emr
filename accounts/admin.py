from django.contrib import admin
from django.contrib.auth.admin import UserAdmin
from .models import User


class CustomUserAdmin(UserAdmin):
    fieldsets = UserAdmin.fieldsets + (
        ('추가 정보', {'fields': ('name', 'age')}),
    )
    list_display = ('username', 'name', 'is_staff', 'is_superuser')


admin.site.register(User, CustomUserAdmin)