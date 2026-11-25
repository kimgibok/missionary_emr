from zoneinfo import ZoneInfo

from django.conf import settings
from django.utils import timezone

from .models import SiteConfig


def get_site_time_zone():
    """관리자 화면에서 정한 현장 시간대 이름. 아직 정하지 않았으면 settings.TIME_ZONE (local_settings.py)"""
    name = SiteConfig.objects.filter(pk=1).values_list('time_zone', flat=True).first()
    return name or settings.TIME_ZONE


class SiteTimezoneMiddleware:
    """
    요청마다 현장 시간대를 켠다. 그래서 timezone.localdate()('오늘'), 로그인 때 진행 중인 미션 판단,
    API가 돌려주는 시각이 모두 관리자 설정을 따른다. DB에는 시각이 UTC로 저장되므로 바꿔도 지난 기록은 그대로다.
    설정값을 요청마다 읽는다(아주 작은 조회 한 번) - 바꾸면 다음 요청부터 모든 기기에 바로 적용된다.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        try:
            timezone.activate(ZoneInfo(get_site_time_zone()))
        except Exception:
            # 마이그레이션 전이거나 저장된 이름이 잘못됐으면 기본 시간대로
            timezone.deactivate()
        try:
            return self.get_response(request)
        finally:
            timezone.deactivate()
