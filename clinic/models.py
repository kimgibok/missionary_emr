from django.db import models
from django.conf import settings


class Mission(models.Model):
    country = models.CharField(max_length=100)
    start_date = models.DateField()
    end_date = models.DateField()

    def __str__(self):
        return f"{self.country} ({self.start_date} ~ {self.end_date})"


class Role(models.Model):
    """
    안내팀/접수팀/약국팀/진료팀/수술팀 등 역할 마스터.
    새 역할이 생기면 코드 수정 없이 admin에서 row 추가.
    """
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class MissionMembership(models.Model):
    """
    같은 사람이 미션마다 다른 역할로 참여할 수 있어서
    User에 role을 고정하지 않고 이 테이블로 관리.
    한 미션 안에서 한 사람은 역할 하나만 가능.
    """
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    mission = models.ForeignKey(Mission, on_delete=models.CASCADE)
    role = models.ForeignKey(Role, on_delete=models.PROTECT)

    class Meta:
        unique_together = ("user", "mission")

    def __str__(self):
        return f"{self.user} - {self.mission} - {self.role}"


class Department(models.Model):
    """15개 진료과 마스터"""
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class DrugCategory1(models.Model):
    """경구/외용/비타민/주사제/소아/추가 - 엑셀 시트 탭 기준"""
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class DrugCategory2(models.Model):
    """세부 약리분류 (구충제, 항생제 등) - cat1과 독립적"""
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name