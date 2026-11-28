"""
약품 엑셀 → 분류(DrugCategory1·2) · 약품(Drug) · 창고 배치(DrugBatch)

    python manage.py import_drugs "db/약품_리스트_아가페_2026_약품분류용1.xlsx"            # 미리보기 (DB 그대로)
    python manage.py import_drugs "db/약품_리스트_아가페_2026_약품분류용1.xlsx" --commit   # 실제로 넣기

읽기·넣기 규칙은 clinic/drug_excel.py에 있다 (관리자 화면의 [엑셀 올리기]와 같은 코드).
표준 양식(관리자 [엑셀 내려받기])과 옛 '약품 리스트' 양식을 둘 다 받는다.
"""
import datetime

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from clinic.drug_excel import DrugImporter
from clinic.models import DrugBatch


class Command(BaseCommand):
    help = '약품 엑셀을 분류·약품·창고 배치로 가져온다 (기본은 미리보기, --commit이면 실제로 넣는다)'

    def add_arguments(self, parser):
        parser.add_argument('path', help='엑셀 파일 경로')
        parser.add_argument('--commit', action='store_true', help='실제로 DB에 넣는다 (없으면 미리보기)')
        parser.add_argument(
            '--source', default='donation', choices=[c for c, _ in DrugBatch.Source.choices],
            help='출처가 없는 새 배치의 출처 (기본 donation=후원)',
        )
        parser.add_argument('--received-date', help='입고일이 없는 새 배치의 입고일 YYYY-MM-DD (기본 오늘)')

    def handle(self, *args, **options):
        try:
            received = (
                datetime.date.fromisoformat(options['received_date']) if options['received_date'] else timezone.localdate()
            )
        except ValueError:
            raise CommandError('--received-date는 YYYY-MM-DD 형식이어야 합니다.')

        try:
            with open(options['path'], 'rb') as file:
                result = DrugImporter(source=options['source'], received=received).run(file, commit=options['commit'])
        except FileNotFoundError:
            raise CommandError(f'파일이 없습니다: {options["path"]}')

        self.stdout.write('\n'.join(result['lines']))
        if result['errors']:
            self.stdout.write(self.style.ERROR('\n'.join(result['errors'])))
            raise CommandError(f'오류 {len(result["errors"])}개 - 아무것도 넣지 않았습니다.')

        summary = ', '.join(f'{k} {v}' for k, v in result['summary']) or '바뀐 것 없음'
        if result['committed']:
            self.stdout.write(self.style.SUCCESS(f'넣었습니다: {summary}'))
        else:
            self.stdout.write(self.style.WARNING(f'미리보기 (DB는 그대로): {summary}'))
            self.stdout.write('실제로 넣으려면 같은 명령에 --commit 을 붙이세요.')
