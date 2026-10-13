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


def owns_visit_department(user, visit_department):
    """그 배정을 받은 의사 본인이면 True. superuser는 항상 True."""
    return user.is_superuser or visit_department.user_id == user.id


class IsPrescriptionOwner(BasePermission):
    """
    처방(또는 처방약)을 쓴 의사 본인만 통과. superuser는 항상 통과.
    처방에는 작성자 필드가 없으므로 '그 처방이 달린 배정의 의사'를 작성자로 본다.
    역할 확인은 하지 않으니 IsClinicalTeam과 같이 쓴다.
    새로 만드는 요청(POST)은 대상 객체가 없어 여기서 못 막으므로 뷰의 perform_create에서
    owns_visit_department()로 확인한다.
    """
    message = '본인이 작성한 처방만 수정·삭제할 수 있습니다.'

    def has_object_permission(self, request, view, obj):
        prescription = getattr(obj, 'prescription', obj)  # 처방약이면 상위 처방으로
        return owns_visit_department(request.user, prescription.visit_department)