from django.utils import timezone
from rest_framework import serializers

from .models import (
    Patient, Visit, VisitDepartment, Department, DrugCategory1, DrugCategory2,
    Prescription, PrescriptionDrug, MissionStock,
)


# =====================================================
# 환자 / 방문
# =====================================================

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
        extra_kwargs = {'chief_complaint': {'allow_blank': False}}


class VisitAssignmentSerializer(serializers.ModelSerializer):
    """방문에 배정된 의사 한 명의 요약 (접수 리스트/상세, 진료 상세의 '다른 의사 배정 현황')"""
    doctor_id = serializers.IntegerField(source='user_id', read_only=True)
    doctor_name = serializers.SerializerMethodField()
    department_code = serializers.SerializerMethodField()

    class Meta:
        model = VisitDepartment
        fields = ['id', 'doctor_id', 'doctor_name', 'department_code', 'is_done', 'assigned_by']

    def get_doctor_name(self, obj):
        return obj.user.name or obj.user.username

    def get_department_code(self, obj):
        return obj.user.primary_department.name if obj.user.primary_department else None


class VisitIntakeListSerializer(VisitListSerializer):
    """접수팀 리스트용 - 배정된 의사 요약 포함"""
    assignments = VisitAssignmentSerializer(source='visit_departments', many=True, read_only=True)

    class Meta(VisitListSerializer.Meta):
        fields = VisitListSerializer.Meta.fields + ['assignments']


class VisitIntakeDetailSerializer(VisitDetailSerializer):
    """접수 기록 열람용 - vitals/병력 전체 + 배정된 의사 요약"""
    assignments = VisitAssignmentSerializer(source='visit_departments', many=True, read_only=True)

    class Meta(VisitDetailSerializer.Meta):
        fields = VisitDetailSerializer.Meta.fields + ['assignments']


# =====================================================
# 의사 배정
# =====================================================

class VisitDepartmentCreateSerializer(serializers.ModelSerializer):
    """접수팀 배정 · 진료팀 전과 공용"""
    class Meta:
        model = VisitDepartment
        fields = ['id', 'visit', 'user']
        read_only_fields = ['id']

    def validate(self, attrs):
        # 같은 방문에 같은 의사를 두 번 배정하지 않는다
        if VisitDepartment.objects.filter(visit=attrs['visit'], user=attrs['user']).exists():
            raise serializers.ValidationError({'detail': '이미 이 환자에게 배정된 의사입니다.'})
        return attrs


class VisitDepartmentListSerializer(serializers.ModelSerializer):
    """진료팀 - 내 배정 목록"""
    visit = VisitListSerializer(read_only=True)

    class Meta:
        model = VisitDepartment
        fields = ['id', 'visit', 'assigned_at', 'is_done', 'done_at']


class VisitDepartmentDetailSerializer(serializers.ModelSerializer):
    """진료팀 - 진료 상세 조회 (환자+vitals+병력+배정 현황 nested)"""
    visit = VisitIntakeDetailSerializer(read_only=True)

    class Meta:
        model = VisitDepartment
        fields = ['id', 'visit', 'assigned_at', 'is_done']


class VisitDepartmentDoneSerializer(serializers.ModelSerializer):
    """진료 완료 처리 / 완료 취소용"""
    class Meta:
        model = VisitDepartment
        fields = ['id', 'is_done']
        read_only_fields = ['id']

    def validate(self, attrs):
        # 오류를 'detail'로 내야 화면에 "is_done: ..." 같은 필드명이 붙지 않는다
        is_done = attrs.get('is_done')
        prescriptions = self.instance.prescriptions
        if is_done and not prescriptions.exists():
            # 처방이 없으면 약국 대기에 안 나타나므로 완료를 막는다 (약이 없으면 '처방약 없이' 처방을 저장)
            raise serializers.ValidationError({'detail': '처방을 하나 이상 저장해야 진료를 완료할 수 있습니다.'})
        if is_done is False and prescriptions.filter(is_dispensed=True).exists():
            raise serializers.ValidationError({'detail': '약국에서 이미 수령 처리되어 완료를 취소할 수 없습니다.'})
        return attrs

    def update(self, instance, validated_data):
        # 완료 시각 기록 (완료 목록 최신순 정렬용), 완료 취소하면 비움
        if 'is_done' in validated_data:
            validated_data['done_at'] = timezone.now() if validated_data['is_done'] else None
        if validated_data.get('is_done') is False:
            # 처방을 고쳐 다시 완료하면 수정된 조제지가 약국에서 자동으로 다시 출력되게
            Visit.objects.filter(pk=instance.visit_id).update(slip_printed_at=None)
        return super().update(instance, validated_data)


# =====================================================
# 진료팀 - 마스터 조회 / 약 검색
# =====================================================

class DepartmentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Department
        fields = ['id', 'name']


class DrugCategory1ReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = DrugCategory1
        fields = ['id', 'name', 'uses_dosage_schedule']


class DrugCategory2ReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = DrugCategory2
        fields = ['id', 'name']


class DrugSearchSerializer(serializers.Serializer):
    """진료팀 처방약 검색 - MissionStock 기준, drug 정보 nested"""
    id = serializers.IntegerField()  # mission_stock id
    drug_id = serializers.IntegerField(source='drugbatch.drug_id')
    drug_name = serializers.CharField(source='drugbatch.drug.name')
    ingredient = serializers.CharField(source='drugbatch.drug.ingredient')
    usage = serializers.CharField(source='drugbatch.drug.usage')
    cat1 = serializers.IntegerField(source='drugbatch.drug.cat1_id')
    cat1_name = serializers.CharField(source='drugbatch.drug.cat1.name')
    uses_dosage_schedule = serializers.BooleanField(source='drugbatch.drug.cat1.uses_dosage_schedule')
    cat2 = serializers.IntegerField(source='drugbatch.drug.cat2_id')
    remaining_qty = serializers.IntegerField()


# =====================================================
# 진료팀 - 처방
# =====================================================

class PrescriptionCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Prescription
        fields = ['id', 'visit_department', 'department', 'clinical_note']
        read_only_fields = ['id']


class PrescriptionUpdateSerializer(serializers.ModelSerializer):
    """진료팀 - 처방의 진료과·진료내용 수정"""
    class Meta:
        model = Prescription
        fields = ['id', 'department', 'clinical_note']
        read_only_fields = ['id']


class PrescriptionDrugClinicalItemSerializer(serializers.ModelSerializer):
    """진료팀 처방 목록의 약 항목 - 수정 폼을 채우려고 복용스케줄까지 포함"""
    drug_name = serializers.CharField(source='drug.name', read_only=True)
    uses_dosage_schedule = serializers.BooleanField(source='drug.cat1.uses_dosage_schedule', read_only=True)

    class Meta:
        model = PrescriptionDrug
        fields = [
            'id', 'drug', 'drug_name', 'uses_dosage_schedule',
            'dose_per_intake', 'frequency_per_day', 'duration_days', 'quantity',
        ]


class PrescriptionListSerializer(serializers.ModelSerializer):
    """진료팀 - 내 처방 목록(수정용) / 다른 의사 처방(중복 확인용)"""
    department_name = serializers.CharField(source='department.name', read_only=True)
    items = PrescriptionDrugClinicalItemSerializer(many=True, read_only=True)

    class Meta:
        model = Prescription
        fields = ['id', 'visit_department', 'department', 'department_name', 'clinical_note', 'is_dispensed', 'items']


class PrescriptionDrugCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = PrescriptionDrug
        fields = [
            'id', 'prescription', 'drug',
            'dose_per_intake', 'frequency_per_day', 'duration_days', 'quantity',
        ]
        read_only_fields = ['id']
        extra_kwargs = {'quantity': {'required': False}}


class PrescriptionDrugClinicalUpdateSerializer(serializers.ModelSerializer):
    """진료팀 - 처방약 수정 (약/수량/복용스케줄 전부 변경 가능, save()에서 수량 재계산)"""
    class Meta:
        model = PrescriptionDrug
        fields = ['id', 'prescription', 'drug', 'dose_per_intake', 'frequency_per_day', 'duration_days', 'quantity']
        read_only_fields = ['id', 'prescription']
        extra_kwargs = {'quantity': {'required': False}}


# =====================================================
# 약국팀
# =====================================================

class MissionStockSerializer(serializers.ModelSerializer):
    """약국팀 재고조회 - drugbatch/drug 정보 nested"""
    drug_name = serializers.CharField(source='drugbatch.drug.name', read_only=True)
    ingredient = serializers.CharField(source='drugbatch.drug.ingredient', read_only=True)
    expiry_date = serializers.DateField(source='drugbatch.expiry_date', read_only=True)
    source = serializers.CharField(source='drugbatch.get_source_display', read_only=True)

    class Meta:
        model = MissionStock
        fields = [
            'id', 'drug_name', 'ingredient', 'expiry_date', 'source',
            'allocated_qty', 'remaining_qty', 'donated_qty', 'is_settled',
        ]


class PharmacyDrugItemSerializer(serializers.ModelSerializer):
    """약국팀 처방약 한 줄 - 환자에게 복용법을 설명할 수 있게 복용스케줄·용법 포함"""
    drug_name = serializers.CharField(source='drug.name', read_only=True)
    usage = serializers.CharField(source='drug.usage', read_only=True)
    dispensed_batch = serializers.SerializerMethodField()

    class Meta:
        model = PrescriptionDrug
        fields = [
            'id', 'drug', 'drug_name', 'usage',
            'dose_per_intake', 'frequency_per_day', 'duration_days', 'quantity',
            'dispensed_stock', 'dispensed_batch',
        ]

    def get_dispensed_batch(self, obj):
        """수령 완료 목록에 보일 '조제한 배치' - 유통기한·출처 (수령 전이면 None)"""
        stock = obj.dispensed_stock
        if stock is None:
            return None
        return {'expiry_date': stock.drugbatch.expiry_date, 'source': stock.drugbatch.get_source_display()}


class PharmacyPrescriptionSerializer(serializers.ModelSerializer):
    """약국팀 처방 한 건 - 진료과·의사·진료내용 + 처방약 목록"""
    department_name = serializers.CharField(source='department.name', read_only=True)
    doctor_name = serializers.SerializerMethodField()
    items = PharmacyDrugItemSerializer(many=True, read_only=True)

    class Meta:
        model = Prescription
        fields = ['id', 'department_name', 'doctor_name', 'clinical_note', 'is_dispensed', 'dispensed_at', 'items']

    def get_doctor_name(self, obj):
        doctor = obj.visit_department.user
        return doctor.name or doctor.username


def find_stock_issues(prescriptions, stock_max):
    """
    조제 전에 의사 확인이 필요한 처방약 목록 - 조제지·자동 출력 경고·목록 태그용.
    prescriptions: 직렬화된 처방 목록, stock_max: {약 id: 이번 미션(정산 전) 배치 중 가장 많이 남은 잔량}
    유통기한이 지난 배치는 현장 판단에 맡기므로 문제로 보지 않는다.
    """
    issues = []
    for prescription in prescriptions:
        for item in prescription['items']:
            best = stock_max.get(item['drug'])
            if item['quantity'] == 0:
                message = '수량 0 (처방 확인 필요)'
            elif best is None:
                message = '이번 미션 재고에 없음'
            elif best < item['quantity']:
                message = f"재고 부족 (필요 {item['quantity']}, 가장 많이 남은 배치 {best})"
            else:
                continue
            issues.append({'prescription_drug': item['id'], 'drug_name': item['drug_name'], 'message': message})
    return issues


class PharmacyVisitSerializer(serializers.ModelSerializer):
    """
    약국팀 환자(방문) 단위 표현 - 조제 대기 / 수령 완료 목록 / 조제 화면 공용.
    context['dispensed']가 True면 수령된 처방만, 아니면 미수령 처방만 담는다.
    context['stock_max']가 있으면 stock_issues(재고 확인이 필요한 약)를 같이 담는다.
    """
    patient = PatientSerializer(read_only=True)
    prescriptions = serializers.SerializerMethodField()

    class Meta:
        model = Visit
        fields = [
            'id', 'reg_no', 'visit_date', 'patient', 'weight', 'has_allergy', 'allergy_detail',
            'slip_printed_at', 'prescriptions',
        ]

    def to_representation(self, instance):
        data = super().to_representation(instance)
        stock_max = self.context.get('stock_max')
        if stock_max is not None:
            data['stock_issues'] = find_stock_issues(data['prescriptions'], stock_max)
        return data

    def get_prescriptions(self, obj):
        qs = (
            Prescription.objects.filter(
                visit_department__visit=obj, is_dispensed=self.context.get('dispensed', False)
            )
            .select_related('department', 'visit_department__user')
            .prefetch_related('items__drug', 'items__dispensed_stock__drugbatch')
            .order_by('id')
        )
        return PharmacyPrescriptionSerializer(qs, many=True).data


class PrescriptionDrugUpdateSerializer(serializers.ModelSerializer):
    """
    약국팀 - 처방약 수량 수정(1 이상). 약국이 조정한 수량을 그대로 믿고 재계산하지 않는다.
    재고가 없어 약을 바꾸거나 빼야 하면 0으로 만들지 않고 의사가 [완료 취소] 후 수정한다.
    """
    class Meta:
        model = PrescriptionDrug
        fields = ['id', 'quantity']
        read_only_fields = ['id']
        extra_kwargs = {'quantity': {'required': True, 'min_value': 1}}

    def update(self, instance, validated_data):
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        # serializer.save(skip_recalculate=True)로 넘기면 DRF가 데이터로 취급하므로 직접 호출
        instance.save(skip_recalculate=True)
        return instance
