from rest_framework import serializers

from .models import Patient, Visit, VisitDepartment


class PatientSerializer(serializers.ModelSerializer):
    class Meta:
        model = Patient
        fields = ['id', 'name_kr', 'name_local', 'sex', 'birth_year']


class VisitCreateSerializer(serializers.ModelSerializer):
    """안내팀 - 방문 등록용. mission·visit_date·reg_no는 서버가 채움."""
    class Meta:
        model = Visit
        fields = ['id', 'patient', 'weight', 'mission', 'visit_date', 'reg_no']
        read_only_fields = ['id', 'mission', 'visit_date', 'reg_no']


class VisitListSerializer(serializers.ModelSerializer):
    """대기 리스트 등에서 쓰는 간단한 표현"""
    patient = PatientSerializer(read_only=True)

    class Meta:
        model = Visit
        fields = ['id', 'reg_no', 'visit_date', 'patient']


class VisitVitalsSerializer(serializers.ModelSerializer):
    """접수팀·진료팀 - vitals/병력 입력·수정용. weight는 여기서 다루지 않음."""
    class Meta:
        model = Visit
        fields = [
            'id', 'bp', 'pr', 'bt', 'bst', 'is_preg',
            'has_htn', 'has_dm', 'has_tbc', 'has_hepatitis',
            'has_allergy', 'allergy_detail',
            'has_operation', 'operation_detail',
            'history_etc', 'chief_complaint', 'symptom_duration',
        ]
        read_only_fields = ['id']


class VisitDepartmentCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = VisitDepartment
        fields = ['id', 'visit', 'user']
        read_only_fields = ['id']