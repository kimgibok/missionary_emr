from datetime import timedelta

from django.utils import timezone
from rest_framework.authentication import TokenAuthentication
from rest_framework.exceptions import AuthenticationFailed

TOKEN_EXPIRE_HOURS = 8


class ExpiringTokenAuthentication(TokenAuthentication):
    """
    DRF 기본 TokenAuthentication은 만료 개념이 없어서,
    발급 후 8시간 지나면 무효화되도록 확장.
    """

    def authenticate_credentials(self, key):
        user, token = super().authenticate_credentials(key)

        if timezone.now() - token.created > timedelta(hours=TOKEN_EXPIRE_HOURS):
            raise AuthenticationFailed('토큰이 만료되었습니다. 다시 로그인해주세요.')

        return user, token