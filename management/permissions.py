from rest_framework.permissions import BasePermission


class IsSuperUser(BasePermission):
    """관리자 전용 - DRF 기본 IsAdminUser는 is_staff를 보는데,
    우리는 정확히 is_superuser 기준으로 관리자를 구분하고 싶어서 직접 정의"""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_superuser)