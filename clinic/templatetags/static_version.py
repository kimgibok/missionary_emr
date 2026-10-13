"""
정적 파일 주소 뒤에 ?v=파일수정시각을 붙이는 템플릿 태그.

브라우저는 JS·CSS를 주소 기준으로 캐시해서, 파일을 고쳐도 주소가 같으면 예전 파일을 쓴다.
파일이 바뀌면 수정시각이 바뀌어 주소도 바뀌므로 모든 기기가 다음 새로고침 때 새 파일을 받는다.
안 바뀐 파일은 주소가 그대로라 계속 캐시를 쓴다.

사용: {% load static_version %} ... <script src="{% static_v 'js/clinical.js' %}"></script>
"""
import os

from django import template
from django.contrib.staticfiles import finders
from django.templatetags.static import static

register = template.Library()


@register.simple_tag
def static_v(path):
    url = static(path)
    file_path = finders.find(path)
    if not file_path:
        return url   # 파일을 못 찾으면 버전 없이 (페이지가 깨지지 않게)
    return f'{url}?v={int(os.path.getmtime(file_path))}'
