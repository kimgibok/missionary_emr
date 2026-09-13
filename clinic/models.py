from django.db import models
from django.conf import settings


class Mission(models.Model):
    country = models.CharField(max_length=100)
    start_date = models.DateField()
    end_date = models.DateField()

    def __str__(self):
        return f"{self.country} ({self.start_date} ~ {self.end_date})"


class Role(models.Model):
    """
    안내팀/접수팀/약국팀/진료팀/수술팀 등 역할 마스터.
    새 역할이 생기면 코드 수정 없이 admin에서 row 추가.
    """
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class MissionMembership(models.Model):
    """
    같은 사람이 미션마다 다른 역할로 참여할 수 있어서
    User에 role을 고정하지 않고 이 테이블로 관리.
    한 미션 안에서 한 사람은 역할 하나만 가능.
    """
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    mission = models.ForeignKey(Mission, on_delete=models.CASCADE)
    role = models.ForeignKey(Role, on_delete=models.PROTECT)

    class Meta:
        unique_together = ("user", "mission")

    def __str__(self):
        return f"{self.user} - {self.mission} - {self.role}"


class Department(models.Model):
    """15개 진료과 마스터"""
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class DrugCategory1(models.Model):
    """경구/외용/비타민/주사제/소아/추가 - 엑셀 시트 탭 기준"""
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class DrugCategory2(models.Model):
    """세부 약리분류 (구충제, 항생제 등) - cat1과 독립적"""
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name
    
    
class Patient(models.Model):
    class Sex(models.TextChoices):
        MALE = "M", "남"
        FEMALE = "F", "여"

    name_kr = models.CharField(max_length=50)
    name_local = models.CharField(max_length=100, blank=True)
    sex = models.CharField(max_length=1, choices=Sex.choices)
    birth_year = models.PositiveIntegerField()

    def __str__(self):
        return f"{self.name_kr} ({self.birth_year})"
    

class Visit(models.Model):
    patient = models.ForeignKey(Patient, on_delete=models.CASCADE, related_name="visits")
    mission = models.ForeignKey(Mission, on_delete=models.CASCADE, related_name="visits")
    visit_date = models.DateField()
    reg_no = models.PositiveIntegerField()

    # 체중 - 나이 제한 없이 선택 입력 (보통 안내팀이 소아만 입력)
    weight = models.FloatField(null=True, blank=True)

    # vitals - 접수팀 입력(혈압, 맥박, 체온, 혈당, 임신여부)
    bp = models.CharField(max_length=20, blank=True)          # "120/80" 형태 문자열 
    pr = models.PositiveIntegerField(null=True, blank=True)
    bt = models.FloatField(null=True, blank=True)
    bst = models.FloatField(null=True, blank=True)
    is_preg = models.BooleanField(default=False)

    # 병력 체크박스
    has_htn = models.BooleanField(default=False)    # 고혈압
    has_dm = models.BooleanField(default=False)     # 당뇨
    has_tbc = models.BooleanField(default=False)    # 결핵
    has_hepatitis = models.BooleanField(default=False)    # 간염
    has_allergy = models.BooleanField(default=False)
    allergy_detail = models.CharField(max_length=200, blank=True)
    has_operation = models.BooleanField(default=False)
    operation_detail = models.CharField(max_length=200, blank=True)
    history_etc = models.CharField(max_length=200, blank=True)

    # 주호소
    chief_complaint = models.CharField(max_length=200, blank=True)
    symptom_duration = models.CharField(max_length=100, blank=True)

    class Meta:
        unique_together = ("mission", "visit_date", "reg_no")

    def __str__(self):
        return f"{self.patient.name_kr} - {self.mission} - {self.visit_date} #{self.reg_no}"
    

class VisitDepartment(models.Model):
    """
    이름과 달리 '진료과 배정'이 아니라 '의사 배정' 기록.
    의료봉사 특성상 의사 전공과 실제 담당 과가 다를 수 있어서
    배정 시점엔 과가 정해지지 않고, department는 Prescription에서 확정됨.
    """
    visit = models.ForeignKey(Visit, on_delete=models.CASCADE, related_name="visit_departments")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="assigned_visits")    # 배정의사
    assigned_at = models.DateTimeField(auto_now_add=True)
    is_done = models.BooleanField(default=False)    # 진료완료

    def __str__(self):
        return f"{self.visit} → {self.user}"
    
    
class Drug(models.Model):
    cat1 = models.ForeignKey(DrugCategory1, on_delete=models.PROTECT, related_name="drugs")
    cat2 = models.ForeignKey(DrugCategory2, on_delete=models.PROTECT, related_name="drugs")
    name = models.CharField(max_length=100)
    ingredient = models.CharField(max_length=200, blank=True)
    usage = models.CharField(max_length=200, blank=True)

    def __str__(self):
        return self.name
    

class DrugBatch(models.Model):
    class Source(models.TextChoices):
        DONATION = "donation", "후원"
        LOCAL = "local", "현지"
        PURCHASE = "purchase", "구매"
        LOCAL_PURCHASE = "local_purchase", "현지구매"
        ETC = "etc", "기타"

    drug = models.ForeignKey(Drug, on_delete=models.PROTECT, related_name="batches")
    source = models.CharField(max_length=20, choices=Source.choices)
    source_detail = models.CharField(max_length=100, blank=True)  # "기타" 선택 시 상세 내용
    received_date = models.DateField()  # 입고일
    expiry_date = models.DateField()
    unit_qty = models.PositiveIntegerField()
    unit_label = models.CharField(max_length=20)
    total_qty = models.PositiveIntegerField()   # 입고량
    remaining_qty = models.PositiveIntegerField()   # 창고 잔량

    def __str__(self):
        return f"{self.drug} - {self.expiry_date} (잔량 {self.remaining_qty})"
    
    
class MissionStock(models.Model):
    """
    창고 재고(DrugBatch) 중 이번 미션에 챙겨간 몫.
    처방 시 재고 차감은 여기서 이뤄짐 (DrugBatch가 아님).
    """
    drugbatch = models.ForeignKey(DrugBatch, on_delete=models.PROTECT, related_name="mission_stocks")
    mission = models.ForeignKey(Mission, on_delete=models.CASCADE, related_name="mission_stocks")
    allocated_qty = models.PositiveIntegerField()   # 이번 미션에 챙겨갼 양
    remaining_qty = models.PositiveIntegerField()   # 현장 잔량(처방 시 차감)
    donated_qty = models.PositiveIntegerField(default=0) # 현지 기부량(정산 시 입력)
    is_settled = models.BooleanField(default=False)     # 정산 완료 여부

    def __str__(self):
        return f"{self.drugbatch.drug} - {self.mission} (현장잔량 {self.remaining_qty})"
    
    
class Prescription(models.Model):
    """
    department는 여기서 확정됨 (VisitDepartment 배정 시점이 아니라
    의사가 실제 진료/처방하는 순간에 결정).
    """
    visit_department = models.ForeignKey(VisitDepartment, on_delete=models.CASCADE, related_name="prescriptions")
    department = models.ForeignKey(Department, on_delete=models.PROTECT, related_name="prescriptions")  # 진료 시점에 확정
    clinical_note = models.TextField(blank=True)
    is_dispensed = models.BooleanField(default=False)   # 약 수령 완료

    def __str__(self):
        return f"{self.visit_department} - {self.department}"
    

class PrescriptionDrug(models.Model):
    prescription = models.ForeignKey(Prescription, on_delete=models.CASCADE, related_name="items")
    drug = models.ForeignKey(Drug, on_delete=models.PROTECT, related_name="prescription_items")

    dose_per_intake = models.FloatField(null=True, blank=True)        # 1회 복용량
    frequency_per_day = models.PositiveIntegerField(null=True, blank=True)  # 1일 복용횟수 (경구/소아약만)
    duration_days = models.PositiveIntegerField(null=True, blank=True)      # 복용일수 (경구/소아약만)
    quantity = models.PositiveIntegerField(default=0)   # 최종 수량, 재고차감 기준

        
    def save(self, *args, skip_recalculate=False, **kwargs):
        # 1회 복용량 × 1일 횟수 × 복용일수가 다 있으면 quantity 자동 계산
        # (외용약처럼 세 값이 없는 경우엔 quantity를 직접 입력한 값 그대로 사용)
        if not skip_recalculate and self.dose_per_intake and self.frequency_per_day and self.duration_days:
            self.quantity = round(self.dose_per_intake * self.frequency_per_day * self.duration_days)
        super().save(*args, **kwargs)

    def __str__(self):
        return f"{self.prescription} - {self.drug} x{self.quantity}"