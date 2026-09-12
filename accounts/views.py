from django.contrib.auth import authenticate
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from clinic.models import MissionMembership

from .serializers import LoginSerializer


class LoginView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        serializer = LoginSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        user = authenticate(
            username=serializer.validated_data['username'],
            password=serializer.validated_data['password'],
        )
        if user is None:
            return Response({'detail': '아이디 또는 비밀번호가 올바르지 않습니다.'}, status=401)

        # 로그인할 때마다 토큰을 새로 발급해서 만료 타이머를 리셋함
        Token.objects.filter(user=user).delete()
        token = Token.objects.create(user=user)

        today = timezone.localdate()
        memberships = MissionMembership.objects.filter(
            user=user,
            mission__start_date__lte=today,
            mission__end_date__gte=today,
        ).select_related('mission', 'role')

        current_missions = [
            {
                'mission_id': m.mission_id,
                'country': m.mission.country,
                'role': m.role.name,
            }
            for m in memberships
        ]

        return Response({
            'token': token.key,
            'name': user.name,
            'current_missions': current_missions,
        })


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        request.user.auth_token.delete()
        return Response(status=204)