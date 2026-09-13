from rest_framework import serializers

from clinic.models import Drug, DrugCategory1, DrugCategory2, DrugBatch, MissionStock, Mission


class MissionSerializer(serializers.ModelSerializer):
    class Meta:
        model = Mission
        fields = ['id', 'country', 'start_date', 'end_date']


class DrugCategory1Serializer(serializers.ModelSerializer):
    class Meta:
        model = DrugCategory1
        fields = ['id', 'name']


class DrugCategory2Serializer(serializers.ModelSerializer):
    class Meta:
        model = DrugCategory2
        fields = ['id', 'name']


class DrugSerializer(serializers.ModelSerializer):
    class Meta:
        model = Drug
        fields = ['id', 'cat1', 'cat2', 'name', 'ingredient', 'usage']


class DrugBatchSerializer(serializers.ModelSerializer):
    class Meta:
        model = DrugBatch
        fields = [
            'id', 'drug', 'source', 'source_detail', 'received_date', 'expiry_date',
            'unit_qty', 'unit_label', 'total_qty', 'remaining_qty',
        ]


class MissionStockSerializer(serializers.ModelSerializer):
    """관리자 - 미션 재고 배분/정산용. 소진율 계산 필드 포함"""
    drug_name = serializers.CharField(source='drugbatch.drug.name', read_only=True)
    consumption_rate = serializers.SerializerMethodField()

    class Meta:
        model = MissionStock
        fields = [
            'id', 'drugbatch', 'mission', 'drug_name',
            'allocated_qty', 'remaining_qty', 'donated_qty', 'is_settled',
            'consumption_rate',
        ]

    def get_consumption_rate(self, obj):
        if obj.allocated_qty == 0:
            return 0
        used = obj.allocated_qty - obj.remaining_qty
        return round(used / obj.allocated_qty, 2)