# 현장별 설정 견본.
# 이 파일을 같은 폴더에 local_settings.py로 복사해서 현장에 맞게 고친다.
# local_settings.py는 git에 올라가지 않는다.

# 현장 시간대 (IANA 이름). 예: 캄보디아 'Asia/Phnom_Penh', 태국 'Asia/Bangkok', 필리핀 'Asia/Manila'
TIME_ZONE = 'Asia/Phnom_Penh'

# 현장 투입 전 채울 것
# DEBUG = False
# SECRET_KEY = '새로 만든 긴 무작위 문자열'
# ALLOWED_HOSTS = ['192.168.0.10', 'localhost']

# 식약처 의약품 제품 허가정보 API 인증키 (공공데이터포털 마이페이지 → 일반 인증키 'Decoding')
# 관리자 [약품] 모달의 [약 정보 찾기]에 쓴다. 비워 두면 그 버튼만 꺼진다.
# MFDS_API_KEY = '여기에 인증키'
