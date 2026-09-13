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
        

## 진료팀이 확인할 데이터 serializer
class VisitDetailSerializer(serializers.ModelSerializer):
    """진료 상세화면 - vitals/병력 전체 포함"""
    patient = PatientSerializer(read_only=True)

    class Meta:
        model = Visit
        fields = [
            'id', 'reg_no', 'visit_date', 'patient', 'weight',
            'bp', 'pr', 'bt', 'bst', 'is_preg',
            'has_htn', 'has_dm', 'has_tbc', 'has_hepatitis',
            'has_allergy', 'allergy_detail',
            'has_operation', 'operation_detail',
            'history_etc', 'chief_complaint', 'symptom_duration',
        ]


class VisitDepartmentListSerializer(serializers.ModelSerializer):
    """진료팀 - 내 배정 목록"""
    visit = VisitListSerializer(read_only=True)

    class Meta:
        model = VisitDepartment
        fields = ['id', 'visit', 'assigned_at', 'is_done']


class VisitDepartmentDetailSerializer(serializers.ModelSerializer):
    """진료팀 - 진료 상세 조회 (환자+vitals+병력 nested)"""
    visit = VisitDetailSerializer(read_only=True)

    class Meta:
        model = VisitDepartment
        fields = ['id', 'visit', 'assigned_at', 'is_done']


class VisitDepartmentDoneSerializer(serializers.ModelSerializer):
    """진료 완료 처리용"""
    class Meta:
        model = VisitDepartment
        fields = ['id', 'is_done']
        read_only_fields = ['id']
        
## 진료팀 - 처방 관련 serializer
from .models import Prescription, PrescriptionDrug, MissionStock


class PrescriptionCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Prescription
        fields = ['id', 'visit_department', 'department', 'clinical_note']
        read_only_fields = ['id']


class PrescriptionDrugCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = PrescriptionDrug
        fields = [
            'id', 'prescription', 'drug',
            'dose_per_intake', 'frequency_per_day', 'duration_days', 'quantity',
        ]
        read_only_fields = ['id']
        extra_kwargs = {'quantity': {'required': False}}


class DrugSearchSerializer(serializers.Serializer):
    """진료팀 처방약 검색 - missionstock 기준, drug 정보 nested"""
    id = serializers.IntegerField()  # mission_stock id
    drug_name = serializers.CharField(source='drugbatch.drug.name')
    ingredient = serializers.CharField(source='drugbatch.drug.ingredient')
    usage = serializers.CharField(source='drugbatch.drug.usage')
    cat1 = serializers.IntegerField(source='drugbatch.drug.cat1_id')
    cat2 = serializers.IntegerField(source='drugbatch.drug.cat2_id')
    remaining_qty = serializers.IntegerField()
    
    
## 약국팀
class MissionStockSerializer(serializers.ModelSerializer):
    """약국팀 재고조회 - drugbatch/drug 정보 nested"""
    drug_name = serializers.CharField(source='drugbatch.drug.name', read_only=True)
    ingredient = serializers.CharField(source='drugbatch.drug.ingredient', read_only=True)
    expiry_date = serializers.DateField(source='drugbatch.expiry_date', read_only=True)
    source = serializers.CharField(source='drugbatch.source', read_only=True)

    class Meta:
        model = MissionStock
        fields = [
            'id', 'drug_name', 'ingredient', 'expiry_date', 'source',
            'allocated_qty', 'remaining_qty', 'donated_qty', 'is_settled',
        ]


class PrescriptionDrugItemSerializer(serializers.ModelSerializer):
    drug_name = serializers.CharField(source='drug.name', read_only=True)

    class Meta:
        model = PrescriptionDrug
        fields = ['id', 'drug_name', 'quantity']


class PrescriptionWithItemsSerializer(serializers.ModelSerializer):
    """약국팀 처방대기리스트에서 쓰는 처방 표현 - 처방약 목록 nested"""
    items = PrescriptionDrugItemSerializer(many=True, read_only=True)
    department_name = serializers.CharField(source='department.name', read_only=True)

    class Meta:
        model = Prescription
        fields = ['id', 'department_name', 'items']


class PharmacyQueueSerializer(serializers.ModelSerializer):
    """약국팀 대기리스트 - 환자 단위, 미수령 처방들 nested"""
    patient = PatientSerializer(read_only=True)
    prescriptions = serializers.SerializerMethodField()

    class Meta:
        model = Visit
        fields = ['id', 'reg_no', 'patient', 'prescriptions']

    def get_prescriptions(self, obj):
        qs = Prescription.objects.filter(
            visit_department__visit=obj, is_dispensed=False
        ).select_related('department').prefetch_related('items__drug')
        return PrescriptionWithItemsSerializer(qs, many=True).data
    
    
class PrescriptionDrugUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = PrescriptionDrug
        fields = ['id', 'prescription', 'drug', 'dose_per_intake', 'frequency_per_day', 'duration_days', 'quantity']
        read_only_fields = ['id']

    def update(self, instance, validated_data):
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save(skip_recalculate=True)
        return instance