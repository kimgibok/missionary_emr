from django.utils import timezone
from rest_framework.permissions import BasePermission

from .models import MissionMembership, VisitDepartment


def get_active_memberships(user):
    """로그인한 유저의 '현재 진행중인 미션'에서의 멤버십들"""
    today = timezone.localdate()
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


# ----- 객체 단위 확인 (본인 배정·본인 처방 등) -----
# 역할 클래스(IsClinicalTeam 등)와 함께 쓴다. 아래 함수·클래스는 역할 자체는 확인하지 않는다.

def is_superuser_or_reception(user):
    """배정을 자유롭게 추가·취소할 수 있는 사람 (superuser 또는 이번 미션의 접수팀)"""
    return user.is_superuser or has_role(user, ['접수팀'])


def can_add_assignment(user, visit):
    """
    이 방문에 의사를 배정(추가)할 수 있는지.
    superuser·접수팀은 어느 방문이든 가능, 진료팀은 그 방문에 '본인의 미완료 배정'이 있을 때만(전과).
    """
    if is_superuser_or_reception(user):
        return True
    return visit.visit_departments.filter(user=user, is_done=False).exists()


class CanCancelAssignment(BasePermission):
    """
    배정 취소(DELETE) 대상 확인. superuser·접수팀은 모든 배정, 진료팀은 본인이 한 배정(assigned_by)만.
    IsReceptionOrClinicalTeam과 같이 쓴다.
    """
    message = '본인이 추가한 배정만 취소할 수 있습니다.'

    def has_object_permission(self, request, view, obj):
        user = request.user
        return is_superuser_or_reception(user) or obj.assigned_by_id == user.id


def is_assigned_to_visit(user, visit_id):
    """이 방문(환자)에 배정된 의사인지 - 같은 환자를 본 다른 의사의 처방을 읽을 때 사용. superuser는 항상 True."""
    return user.is_superuser or VisitDepartment.objects.filter(visit_id=visit_id, user=user).exists()


def owns_visit_department(user, visit_department):
    """그 배정을 받은 의사 본인이면 True. superuser는 항상 True."""
    return user.is_superuser or visit_department.user_id == user.id


class IsAssignedDoctor(BasePermission):
    """
    배정(VisitDepartment) 조회·진료 완료 처리는 그 배정의 의사 본인만. superuser는 항상 통과.
    IsClinicalTeam과 같이 쓴다.
    """
    message = '본인에게 배정된 환자만 조회·처리할 수 있습니다.'

    def has_object_permission(self, request, view, obj):
        return owns_visit_department(request.user, obj)


class IsPrescriptionOwner(BasePermission):
    """
    처방(또는 처방약)을 쓴 의사 본인만 통과. superuser는 항상 통과.
    처방에는 작성자 필드가 없으므로 '그 처방이 달린 배정의 의사'를 작성자로 본다.
    IsClinicalTeam과 같이 쓴다. 새로 만드는 요청(POST)은 대상 객체가 없어 여기서 못 막으므로 뷰의 perform_create에서
    owns_visit_department()로 확인한다.
    """
    message = '본인이 작성한 처방만 수정·삭제할 수 있습니다.'

    def has_object_permission(self, request, view, obj):
        prescription = getattr(obj, 'prescription', obj)  # 처방약이면 상위 처방으로
        return owns_visit_department(request.user, prescription.visit_department)
