from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework import serializers

from clinic.models import Drug, DrugCategory1, DrugCategory2, DrugBatch, MissionStock, Mission, StockAdjustment


# =====================================================
# 창고 재고 이동 도우미 - 동시에 다른 요청이 숫자를 바꿔도 맞도록 조건부 UPDATE로 처리한다
# =====================================================

def take_from_warehouse(drugbatch_id, qty):
    """창고 배치에서 qty만큼 뺀다 (미션 배분). 모자라면 400"""
    if qty <= 0:
        return
    ok = DrugBatch.objects.filter(id=drugbatch_id, remaining_qty__gte=qty).update(remaining_qty=F('remaining_qty') - qty)
    if not ok:
        left = DrugBatch.objects.get(id=drugbatch_id).remaining_qty
        raise serializers.ValidationError({'detail': f'창고 잔량이 부족합니다. (창고 잔량 {left}, 필요 {qty})'})


def return_to_warehouse(drugbatch_id, qty):
    """창고 배치에 qty만큼 돌려준다 (배분 줄이기·삭제, 정산)"""
    if qty > 0:
        DrugBatch.objects.filter(id=drugbatch_id).update(remaining_qty=F('remaining_qty') + qty)


# =====================================================
# 미션
# =====================================================

class MissionSerializer(serializers.ModelSerializer):
    """관리자 - 미션 탭. is_active = 오늘이 미션 기간 안인지 (탭에 '진행중' 표시)"""
    is_active = serializers.SerializerMethodField()

    class Meta:
        model = Mission
        fields = ['id', 'country', 'start_date', 'end_date', 'is_active']

    def get_is_active(self, obj):
        return obj.start_date <= timezone.localdate() <= obj.end_date


# =====================================================
# 약품 · 분류
# =====================================================

class DrugCategory1Serializer(serializers.ModelSerializer):
    class Meta:
        model = DrugCategory1
        fields = ['id', 'name', 'uses_dosage_schedule']


class DrugCategory2Serializer(serializers.ModelSerializer):
    class Meta:
        model = DrugCategory2
        fields = ['id', 'name']


class DrugSerializer(serializers.ModelSerializer):
    cat1_name = serializers.CharField(source='cat1.name', read_only=True)
    cat2_name = serializers.CharField(source='cat2.name', read_only=True)

    class Meta:
        model = Drug
        fields = ['id', 'cat1', 'cat1_name', 'cat2', 'cat2_name', 'name', 'ingredient', 'usage']


# =====================================================
# 창고 재고 (DrugBatch)
# =====================================================

class DrugBatchSerializer(serializers.ModelSerializer):
    """
    창고 배치. 잔량(remaining_qty)은 여기서 직접 못 바꾼다 - 입고 때 = 입고량, 이후는 배분·정산·보정(adjust)으로만.
    입고량을 고치면 잔량도 같은 만큼 같이 바뀐다.
    """
    drug_name = serializers.CharField(source='drug.name', read_only=True)
    cat1_name = serializers.CharField(source='drug.cat1.name', read_only=True)     # 화면의 분류 칩·묶음용
    cat2_name = serializers.CharField(source='drug.cat2.name', read_only=True)
    source_display = serializers.CharField(source='get_source_display', read_only=True)

    class Meta:
        model = DrugBatch
        fields = [
            'id', 'drug', 'drug_name', 'cat1_name', 'cat2_name', 'source', 'source_display', 'source_detail', 'received_date', 'expiry_date',
            'unit_qty', 'unit_label', 'total_qty', 'remaining_qty',
        ]
        read_only_fields = ['remaining_qty']

    def validate(self, attrs):
        instance = self.instance
        if instance and 'drug' in attrs and attrs['drug'] != instance.drug and instance.mission_stocks.exists():
            raise serializers.ValidationError({'detail': '이미 미션에 배분된 배치는 약을 바꿀 수 없습니다.'})
        return attrs

    def create(self, validated_data):
        validated_data['remaining_qty'] = validated_data['total_qty']
        return super().create(validated_data)

    def update(self, instance, validated_data):
        with transaction.atomic():
            if 'total_qty' in validated_data:
                delta = validated_data['total_qty'] - instance.total_qty
                if delta < 0:
                    ok = DrugBatch.objects.filter(id=instance.id, remaining_qty__gte=-delta).update(
                        remaining_qty=F('remaining_qty') + delta,
                    )
                    if not ok:
                        raise serializers.ValidationError({'detail': '입고량을 그만큼 줄이면 창고 잔량이 0보다 작아집니다.'})
                else:
                    return_to_warehouse(instance.id, delta)
                instance.refresh_from_db(fields=['remaining_qty'])
            return super().update(instance, validated_data)


# =====================================================
# 미션 재고 (MissionStock)
# =====================================================

class MissionStockSerializer(serializers.ModelSerializer):
    """
    미션 배분. 만들면 창고에서 배분량만큼 빼고 현장 잔량 = 배분량.
    배분량을 고치면 늘린 만큼 창고에서 더 빼고, 줄인 만큼 돌려준다(정산 전, 현장 잔량 안에서만).
    used_qty(실제로 수령된 양)는 뷰의 queryset annotate 값.
    """
    drug_id = serializers.IntegerField(source='drugbatch.drug_id', read_only=True)
    drug_name = serializers.CharField(source='drugbatch.drug.name', read_only=True)
    ingredient = serializers.CharField(source='drugbatch.drug.ingredient', read_only=True)
    cat1_name = serializers.CharField(source='drugbatch.drug.cat1.name', read_only=True)
    cat2_name = serializers.CharField(source='drugbatch.drug.cat2.name', read_only=True)
    expiry_date = serializers.DateField(source='drugbatch.expiry_date', read_only=True)
    source_display = serializers.CharField(source='drugbatch.get_source_display', read_only=True)
    used_qty = serializers.IntegerField(read_only=True, default=0)
    consumption_rate = serializers.SerializerMethodField()

    class Meta:
        model = MissionStock
        fields = [
            'id', 'drugbatch', 'mission', 'drug_id', 'drug_name', 'ingredient', 'cat1_name', 'cat2_name', 'expiry_date', 'source_display',
            'allocated_qty', 'remaining_qty', 'donated_qty', 'is_settled', 'used_qty', 'consumption_rate',
        ]
        read_only_fields = ['remaining_qty', 'donated_qty', 'is_settled']

    def get_consumption_rate(self, obj):
        """챙겨 간 양 중 실제로 쓴 비율 (0~1)"""
        used = getattr(obj, 'used_qty', 0) or 0
        return round(used / obj.allocated_qty, 2) if obj.allocated_qty else 0

    def validate_allocated_qty(self, value):
        if value < 1:
            raise serializers.ValidationError('배분량은 1 이상이어야 합니다.')
        return value

    def validate(self, attrs):
        instance = self.instance
        if instance is None:
            if MissionStock.objects.filter(drugbatch=attrs['drugbatch'], mission=attrs['mission']).exists():
                raise serializers.ValidationError({'detail': '이미 이 미션에 배분된 배치입니다. 배분량을 수정하세요.'})
            return attrs
        if instance.is_settled:
            raise serializers.ValidationError({'detail': '정산이 끝난 재고는 수정할 수 없습니다.'})
        for field in ('drugbatch', 'mission'):
            if field in attrs and attrs[field] != getattr(instance, field):
                raise serializers.ValidationError({'detail': '배치와 미션은 바꿀 수 없습니다. 삭제하고 새로 배분하세요.'})
        return attrs

    def create(self, validated_data):
        with transaction.atomic():
            take_from_warehouse(validated_data['drugbatch'].id, validated_data['allocated_qty'])
            validated_data['remaining_qty'] = validated_data['allocated_qty']
            return super().create(validated_data)

    def update(self, instance, validated_data):
        new_qty = validated_data.get('allocated_qty', instance.allocated_qty)
        delta = new_qty - instance.allocated_qty
        with transaction.atomic():
            if delta > 0:
                take_from_warehouse(instance.drugbatch_id, delta)
                MissionStock.objects.filter(id=instance.id).update(
                    allocated_qty=new_qty, remaining_qty=F('remaining_qty') + delta,
                )
            elif delta < 0:
                ok = MissionStock.objects.filter(id=instance.id, remaining_qty__gte=-delta).update(
                    allocated_qty=new_qty, remaining_qty=F('remaining_qty') + delta,
                )
                if not ok:
                    raise serializers.ValidationError({
                        'detail': f'현장 잔량({instance.remaining_qty})보다 많이 줄일 수 없습니다. 이미 쓴 양은 돌려줄 수 없어요.'
                    })
                return_to_warehouse(instance.drugbatch_id, -delta)
        instance.refresh_from_db()
        return instance


# =====================================================
# 재고 보정 이력
# =====================================================

class StockAdjustmentSerializer(serializers.ModelSerializer):
    adjusted_by_name = serializers.SerializerMethodField()

    class Meta:
        model = StockAdjustment
        fields = ['id', 'drugbatch', 'mission_stock', 'before_qty', 'after_qty', 'reason', 'adjusted_by_name', 'adjusted_at']

    def get_adjusted_by_name(self, obj):
        user = obj.adjusted_by
        return (user.name or user.username) if user else ''
