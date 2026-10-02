from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    name = models.CharField(max_length=50)
    age = models.PositiveIntegerField(null=True, blank=True)
    primary_department = models.ForeignKey(
        'clinic.Department', on_delete=models.SET_NULL, null=True, blank=True,
        related_name='doctors',
    )

    def __str__(self):
        return f"{self.username} ({self.name})"