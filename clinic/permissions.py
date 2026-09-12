from datetime import date

from rest_framework.permissions import BasePermission

from .models import MissionMembership


def get_active_memberships(user):
    """로그인한 유저의 '현재 진행중인 미션'에서의 멤버십들"""
    today = date.today()
    return MissionMembership.objects.filter(
        user=user,
        mission__start_date__lte=today,
        mission__end_date__gte=today,
    ).select_related('mission', 'role')


def has_role(user, role_names):
    return get_active_memberships(user).filter(role__name__in=role_names).exists()


def role_permission(*role_names):
    """
    주어진 역할 이름들 중 하나라도 가지고 있으면 통과시키는 permission 클래스를 만들어주는 팩토리.
    superuser는 항상 통과.
    """
    class _RolePermission(BasePermission):
        def has_permission(self, request, view):
            user = request.user
            if not user.is_authenticated:
                return False
            if user.is_superuser:
                return True
            return has_role(user, role_names)
    return _RolePermission


IsInfoTeam = role_permission('안내팀')
IsReceptionTeam = role_permission('접수팀')
IsClinicalTeam = role_permission('진료팀')
IsPharmacyTeam = role_permission('약국팀')

# 여러 팀이 같이 쓰는 API용 조합
IsInfoOrReceptionTeam = role_permission('안내팀', '접수팀')
IsReceptionOrClinicalTeam = role_permission('접수팀', '진료팀')
IsInfoOrReceptionOrClinicalTeam = role_permission('안내팀', '접수팀', '진료팀')
IsClinicalOrPharmacyTeam = role_permission('진료팀', '약국팀')