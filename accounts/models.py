from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    """
    커스텀 유저 모델.
    - username을 로그인 ID로 사용
    - 비밀번호는 AbstractUser 기본 해싱 그대로 사용
    - 역할(role)은 미션마다 달라지므로 여기 두지 않고 MissionMembership(clinic 앱)에서 관리
    """
    name = models.CharField(max_length=50)
    age = models.PositiveIntegerField(null=True, blank=True)

    def __str__(self):
        return f"{self.username} ({self.name})"