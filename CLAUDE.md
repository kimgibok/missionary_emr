# CLAUDE.md — 의료선교 EMR (missionary_emr)

## 1. 프로젝트 목적

해외 의료선교(현재 캄보디아) 현장에서 종이 차트·번호표로 하던 진료 업무를 대체하는 **오프라인 EMR**.

- 인터넷이 없는 현장에서 노트북 1대를 서버로 두고, 같은 Wi-Fi(핫스팟)에 붙은 폰·노트북 여러 대가 브라우저로 접속하는 **인트라넷 앱**이다.
- 외부 CDN, 외부 API, 클라우드 서비스에 의존하면 안 된다. 폰트·라이브러리는 전부 로컬에 번들한다.
- 목표: 환자 추적, 처방 관리, 약품 재고 관리, 미션별 통계. 이전 미션은 수기로 기록해서 통계를 낼 수 없었다.
- 역할 5개: 안내팀 / 접수팀 / 진료팀 / 약국팀 / 관리자(superuser). 수술팀은 역할 이름만 있고 워크플로우는 아직 없다.
- 개발자(사용자)가 혼자 유지보수한다. 코드는 읽고 이해할 수 있는 단순한 구조를 유지한다.

## 2. 기술 스택 / 개발 환경

| 항목 | 내용 |
|---|---|
| 백엔드 | Django 5.2 + Django REST Framework (Python 3.11) |
| 인증 | DRF Token 기반, **8시간 만료**(`accounts/authentication.py`의 `ExpiringTokenAuthentication`) |
| DB | SQLite, `db/emr.db` (`.gitignore` 대상) |
| 프론트 | 순수 HTML / CSS / JavaScript (프레임워크·빌드 도구 없음), Django 템플릿으로 서빙 |
| 폰트 | Pretendard `.woff2`를 `static/fonts/`에 로컬 번들 |
| 엑셀 | `openpyxl` (관리자 export) |
| 환경 | Windows, Miniforge conda 환경 `missionary_emr`, VS Code, DBeaver |
| 버전관리 | GitHub, 기능 단위 브랜치 + PR |

실행:

```bash
conda activate missionary_emr
python manage.py runserver                # PC에서만 접속
python manage.py runserver 0.0.0.0:8000   # 같은 Wi-Fi의 폰에서 http://<PC IP>:8000 로 접속
```

## 3. 폴더 구조

```
missionary_emr/
├─ manage.py
├─ config/                  settings.py, urls.py (페이지 라우트 + API include),
│                           local_settings.example.py (현장별 설정 견본 → local_settings.py로 복사, git 제외)
├─ accounts/                커스텀 User, 로그인/로그아웃, 토큰 만료 인증
│   ├─ models.py            User(AbstractUser): name, age, primary_department
│   ├─ authentication.py    ExpiringTokenAuthentication
│   ├─ serializers.py / views.py / urls.py / admin.py
├─ clinic/                  현장 4팀(안내·접수·진료·약국)의 모델과 API
│   ├─ models.py            모든 도메인 모델
│   ├─ permissions.py       role_permission() 팩토리, get_active_memberships(), 본인 배정·처방 확인용 클래스/함수
│   ├─ pagination.py        FlexiblePagination (기본 20, ?page_size= 최대 500)
│   ├─ templatetags/static_version.py   {% static_v %} - 정적 파일 주소에 ?v=수정시각 (캐시 자동 갱신)
│   ├─ serializers.py / views.py / urls.py / admin.py
├─ management/              관리자 전용 API (모델 없음, clinic 모델을 import해서 사용)
│   ├─ permissions.py       IsSuperUser (is_superuser 기준, DRF IsAdminUser 아님)
│   ├─ serializers.py / views.py / urls.py
├─ templates/
│   ├─ login.html, select_mission.html, no_mission.html
│   ├─ roles/               info.html, reception.html, clinical.html, pharmacy.html, admin.html
│   └─ partials/            nav.html, modal.html, patient_intake_modal.html
├─ static/
│   ├─ css/                 base.css(토큰·공통 컴포넌트), login, nav, page, modal, info, reception, clinical, pharmacy(조제지 인쇄 포함)
│   ├─ js/                  api.js, common.js(escapeHtml·showToast·patientMeta·doctorLabel·byId),
│   │                       nav.js, modal.js, login.js, select_mission.js,
│   │                       patient-intake.js, info.js, reception.js, clinical.js, pharmacy.js
│   └─ fonts/               Pretendard-{Regular,Medium,SemiBold,Bold}.woff2
└─ db/emr.db                (gitignore)
```

페이지 URL(`config/urls.py`의 `TemplateView`): `/`(로그인), `/select-mission/`, `/no-mission/`, `/info/`, `/reception/`, `/clinical/`, `/pharmacy/`, `/manage/`.
API는 전부 `/api/v1/` 아래: `auth/`, (clinic) 루트, `manage/`.

## 4. 역할별 주요 기능과 업무 흐름

**로그인 라우팅** (`login.js`): superuser → `/manage/` / 일반 계정은 `current_missions`(오늘 날짜가 start~end 사이인 미션) 개수로 분기 — 0개 `/no-mission/`, 1개 해당 역할 페이지, 2개 이상 `/select-mission/`.
superuser는 백엔드 권한을 전부 통과하므로 nav에서 모든 역할 페이지로 이동해 테스트할 수 있다. 일반 계정은 nav 메뉴가 숨겨진다.

| 역할 | 하는 일 |
|---|---|
| 안내팀 `/info/` | 환자 검색(이번 미션 내) / 신규 등록 / 방문 등록(등록번호 자동 발급, 체중은 선택) / 의사별 대기 인원 확인(번호표 줄 때 참고) |
| 접수팀 `/reception/` | 접수 대기(등록번호 오름차순) / 오늘 접수 완료(등록번호 내림차순, 다시 열어 수정 가능) / 활력징후·병력·주호소 입력 / 의사 배정(다중, 진료 전이면 취소 가능) / 환자정보 수정 / 환자 검색·신규 등록(버튼 → 모달) |
| 진료팀 `/clinical/` | 진료 대기(오늘, 등록번호순) / 오늘 진료 완료(완료 시각 최신순) / 진료 상세(환자·vitals·병력 수정, 다른 의사 배정 현황) / 다른 의사 처방 보기(진료 완료분, 중복 처방 확인용) / 처방 작성(진료과 확정, 약 검색·장바구니)·수정·삭제 / 전과(다른 의사 추가 배정, 내가 한 배정은 진료 전이면 취소) / 진료 완료(처방 1건 이상 필요) · 완료 취소(약국 수령 전까지) |
| 약국팀 `/pharmacy/` | 환자 단위 처방 대기 / 처방약마다 배치(MissionStock) 선택해 조제·재고 차감 / 재고 조회 / 일별 약품 사용 통계 / 처방약 수량 수정 |
| 관리자 `/manage/` | 미션 탭별 통계(소아/성인 × 성별 × 진료과) / 약품·카테고리·창고배치·미션재고 CRUD / 미션 재고 정산 / 엑셀 export. 미션 생성은 Django admin에서 한다 |

**공통 UX 규칙**
- 다른 팀이 입력한 값을 고칠 때는 확인 팝업(모달)을 띄운다.
- 안내팀이 입력한 내용은 접수·진료팀이, 접수팀이 입력한 내용은 진료팀이 볼 수 있고 수정할 수 있다.
- 필수 입력은 **주호소와 의사 배정뿐**이다. 맥박 등 vitals는 전부 선택이다.
- 목록 화면은 10초마다 자동 갱신한다(입력 중에는 갱신을 미룬다).
- 폰에서도 쓴다. 반응형은 필수이고, 터치 영역은 최소 44px로 한다.

## 5. 데이터 모델 핵심 (`clinic/models.py`, `accounts/models.py`)

- `User`: 역할 필드가 **없다**. 역할은 미션마다 달라지므로 `MissionMembership(user, mission, role)`로 관리하고, 한 미션에서 한 사람은 역할 하나(`unique_together=(user, mission)`).
  `primary_department`는 의사의 전문과 표시용 참고 정보일 뿐 배정·처방 로직과 무관하다.
- `Role`, `Department`(진료과 약어: FM, GI, OS, PED …), `DrugCategory1`, `DrugCategory2`는 마스터 테이블이다. admin에서 추가한다(`choices`로 하드코딩하지 않는다).
  `DrugCategory1.uses_dosage_schedule`가 True인 분류만 처방 시 1회량/1일횟수/일수 방식으로 입력한다.
- `Patient`: name_kr, name_local, sex(M/F), `birth_year`. 나이는 `방문연도 − birth_year`로 계산한다. **소아 = 19세 이하, 성인 = 20세 이상.**
- `Visit`: `unique_together=(mission, visit_date, reg_no)`. 등록번호는 미션+날짜 안에서만 유일하고 날짜마다 1부터 시작한다. 체중·vitals·병력 체크박스·주호소를 가진다.
- `VisitDepartment`: **의사 배정 기록**이다(visit, user=의사, assigned_by=배정한 사람, assigned_at, is_done, done_at). department 필드가 없다 — 의사 전공과 실제 담당 과가 다를 수 있기 때문이다.
  `assigned_by`는 POST 시 서버가 요청자로 채운다(진료팀 배정 취소 권한 판단용, 0006 이전 기록은 비어 있음). `done_at`은 완료 시 지금 시각, 완료 취소 시 비움(완료 목록 정렬용).
- `Prescription`: department는 **여기서 확정**된다(visit_department, department, clinical_note, is_dispensed). 한 배정에 처방이 여러 건일 수 있고, 약 없이 처방만 있어도 유효하다(기도만 하는 경우도 약국으로 보낸다).
- `PrescriptionDrug`: dose_per_intake × frequency_per_day × duration_days로 `quantity`를 `save()`에서 자동 계산한다. 세 값이 없으면 quantity를 직접 입력한 값 그대로 쓴다.
- `DrugBatch`는 창고 전체 재고(미션과 무관, source = 후원/현지/구매/현지구매/기타 + source_detail), `MissionStock`은 미션에 챙겨간 몫이다. **처방 시 재고 차감은 `MissionStock.remaining_qty`에서** 일어난다.
  정산: `donated_qty`를 입력하면 `remaining_qty − donated_qty`를 `DrugBatch.remaining_qty`에 합산하고 `is_settled=True`.

**주요 업무 규칙**
- "접수 대기" = 오늘 방문 중 `chief_complaint=''`, "접수 완료" = 주호소가 입력된 방문.
- 접수 기록은 배정된 모든 진료가 끝나면 읽기 전용이다(현재는 프론트에서만 막는다).
- 의사 배정 취소는 그 배정의 `is_done=False`이고 처방이 없을 때만 가능하다. 접수팀은 모든 배정, 진료팀은 **본인이 한 배정(`assigned_by`)만** 취소한다.
- 같은 방문에 같은 의사를 두 번 배정할 수 없다(서버 400).
- 진료팀은 **본인 배정만** 조회·처리하고, 처방 작성·수정·삭제도 본인 배정의 처방만 한다(superuser는 전부).
- 전과(진료팀의 추가 배정)는 그 환자에게 **본인의 미완료 배정**이 있을 때만 된다. 전과해도 내 배정은 자동 완료되지 않는다.
- 진료 완료는 처방이 **1건 이상** 있어야 한다(약이 없으면 '처방약 없이' 처방을 저장). 처방이 없으면 약국 대기에 안 나타나기 때문이다.
- 완료된 배정의 처방은 서버에서도 작성·수정·삭제를 막는다. 고치려면 [완료 취소] → 수정. 완료 취소는 약국 수령(`is_dispensed`) 전까지만 된다.
  vitals는 다른 의사가 아직 진료 중일 수 있어 완료 후에도 서버는 막지 않고 화면에서만 잠근다.
- 같은 환자를 본 다른 의사의 처방은 **진료 완료된 것만** 읽기 전용으로 보여준다(한 환자를 동시에 진료할 일은 없다).
- 약국 대기 목록은 **환자(visit) 단위**다. 오늘 방문 중 배정된 모든 `VisitDepartment`가 완료되고 미수령 처방이 있는 방문만 나오며, 수령 처리는 그 환자의 모든 처방을 한 번에 `is_dispensed=True`, `dispensed_at=지금`으로 만든다.
- 조제할 때 같은 약의 배치가 여러 개면 약국팀이 직접 고른다(자동 FIFO 아님). 화면은 처방 수량만큼 남은 배치가 하나뿐일 때만 미리 고르고,
  잔량이 모자란 배치는 못 고르게 막는다. 유통기한이 지난 배치는 "(지남)" 표시만 하고 고를 수 있다(현장 판단에 맡김). 고른 배치는 `PrescriptionDrug.dispensed_stock`(PROTECT)에 남는다.
  모든 처방약에 배치가 필요하고 수량 0인 약이 있으면 수령을 막는다. 약 없는 처방(기도)은 배치 없이 수령된다.
  재고가 없어 약을 바꾸거나 빼야 하면 0으로 처리하지 않고, 의사가 [완료 취소] → 처방 수정 → 다시 완료한다(그동안 조제 대기에서 빠진다).
- 수령 취소(`undispense`)는 오늘 방문만, 그 환자의 수령된 처방 전부를 대기로 되돌리고 `dispensed_stock`으로 재고를 돌려준다. 수령 후에는 의사의 [완료 취소]가 막히므로, 처방을 고치려면 약국 수령 취소 → 의사 완료 취소 순서다.
- **조제지 자동 출력**: 약국 화면의 [자동 출력] 스위치를 켠 기기(프린터 PC, 설정은 기기별 `localStorage`)만, 조제 대기에 새로 올라온 환자의 조제지(A4, 환자당 한 장)를 인쇄한다.
  `Visit.slip_printed_at`과 `POST visits/print-claim/`(아직 안 찍은 것만 '출력함'으로 바꾸고 그 id만 돌려줌)으로 기기가 둘이어도 한 장만 나온다.
  의사가 [완료 취소]하면 `slip_printed_at`을 비워서 고친 처방이 다시 완료되면 자동으로 다시 나온다. 패널의 [조제지 출력]은 수동/재출력.
  재고 문제(`stock_issues`: 미션 재고에 없음 / 처방 수량만큼 남은 배치 없음 / 수량 0)는 조제지에 찍히고, 출력 PC에 경고창 + 경고음([확인]까지 10초마다 반복), 모든 기기 목록에 '재고 확인' 태그.
  확인창 없이 인쇄하려면 출력 PC의 크롬 바로가기에 `--kiosk-printing`을 붙인다. 브라우저는 클릭 전에는 소리를 막으므로 새로고침 후 화면을 한 번 눌러야 경고음이 난다.
- 약국팀 처방약 수정은 **수량만(1 이상)**, 진료 완료·수령 전·오늘 방문만 된다. 약을 바꾸려면 의사가 [완료 취소] 후 수정한다.
- SQLite는 `select_for_update()`를 무시한다. 수령·수령 취소는 조건부 UPDATE(`is_dispensed=False`인 것만, `remaining_qty__gte=필요량`) 후 바뀐 행 수를 확인해 동시 클릭을 막는다.
- 의사별 대기 인원(`wait-counts`)은 이번 미션의 진료팀 멤버 전원을 보여주고(대기 0명 포함), **오늘 날짜** 미완료 배정만 센다.

## 6. API 요약

모든 요청 헤더: `Authorization: Token <키>`. 로그인 응답: `token`, `name`, `is_superuser`, `current_missions`.
로그인할 때마다 이전 토큰은 삭제되고 새로 발급된다.

| 구분 | 엔드포인트 |
|---|---|
| 인증 | `POST auth/login/`, `POST auth/logout/` |
| 환자 | `GET/POST patients/` (`?search=&scope=current_mission`), `GET/PATCH patients/<pk>/` |
| 방문 | `GET/POST visits/` (`?status=waiting_vitals\|intake_done`), `GET/PATCH visits/<pk>/` |
| 배정 | `GET/POST visit-departments/` (`?is_done=false\|true`), `GET visit-departments/wait-counts/`(안내·접수·진료팀), `GET/PATCH/DELETE visit-departments/<pk>/` (PATCH `{is_done: true\|false}` = 진료 완료/완료 취소) |
| 처방 | `GET/POST prescriptions/` (`?visit_department=` 내 처방, `?visit=` 다른 의사 완료 처방), `PATCH/DELETE prescriptions/<pk>/` (진료과·진료내용 수정 / 처방 삭제), `POST prescription-drugs/` |
| 처방약 수정 | `PATCH prescription-drugs/<pk>/` = 약국팀용(수량만 믿고 재계산 안 함), `PATCH/DELETE prescription-drugs/<pk>/clinical/` = 진료팀용(재계산됨) |
| 조회용 | `GET departments/`, `drug-categories1/`, `drug-categories2/`, `drugs/` (진료팀 약 검색, MissionStock 기준, `?search=&cat1=&cat2=`) |
| 약국 | `GET mission-stocks/`, `GET prescription-drugs/daily-stats/?date=`(수령된 약만), `GET visits/pharmacy-queue/`(오늘, 등록번호순), `GET visits/pharmacy-done/`(오늘 수령, 최신순), `GET visits/<id>/dispense-options/`, `POST visits/<id>/dispense/` `{items:[{prescription_drug, mission_stock}]}`, `POST visits/<id>/undispense/`, `POST visits/print-claim/` `{ids}` → `{claimed}` (조제 대기·조제 화면 응답에 `slip_printed_at`, `stock_issues`) |
| 관리자 `manage/` | `GET missions/`, `GET visits/stats/?mission=`, `GET mission-stocks/export/?mission=`, 그리고 라우터 CRUD: `drug-categories1`, `drug-categories2`, `drugs`, `drug-batches`, `mission-stocks` (`POST mission-stocks/<id>/settle/`) |

권한 클래스(`clinic/permissions.py`): `IsInfoTeam`, `IsReceptionTeam`, `IsClinicalTeam`, `IsPharmacyTeam`와 조합용(`IsInfoOrReceptionTeam` 등).
모두 `role_permission(*역할이름)` 팩토리로 만들며, **superuser는 항상 통과**한다. 역할 이름 문자열('안내팀', '접수팀', '진료팀', '약국팀')은 DB의 `Role.name`과 정확히 같아야 한다.
객체 단위 확인(역할 클래스와 함께 씀): `IsAssignedDoctor`(본인 배정), `IsPrescriptionOwner`(본인 처방·처방약), `CanCancelAssignment`(배정 취소).
POST처럼 대상 객체가 없는 요청은 뷰의 `perform_create`에서 `owns_visit_department()`, `can_add_assignment()`, `is_assigned_to_visit()`로 확인한다.

"현재 미션" 판단은 `get_current_mission(user)`다. 오늘 날짜가 start~end 사이인 멤버십 중 **첫 번째**를 쓴다.
`mission_id`를 요청마다 넘기지 않고 서버가 스코프를 정한다. 관리자 통계·export만 `?mission=`을 받는다.

## 7. 코딩 규칙

**공통**
- 주석, docstring, 사용자에게 보이는 문구는 한국어로 쓴다.
- 새 기능은 `feature/기능이름` 브랜치에서 작업하고 PR로 합친다. 커밋 메시지는 한국어로 "무엇을 했는지" 한 줄로 쓴다.
- 모델·API를 바꿀 때는 `makemigrations <앱>` → `migrate` → `curl` 또는 브라우저로 직접 확인한다.
- 외부 CDN, 외부 패키지(프론트), 인터넷이 필요한 기능은 쓰지 않는다.

**백엔드**
- 역할 확인은 `permissions.py`의 클래스로만 한다. 뷰 안에서 `if role == ...`를 직접 쓰지 않는다.
- 같은 URL에서 메서드별로 serializer·권한이 다르면 `get_serializer_class()`, `get_permissions()`를 오버라이드한다.
- 표준 CRUD가 반복되는 관리자 API는 `ModelViewSet` + `DefaultRouter`를 쓴다. 현장 4팀 API는 `generics.*View`로 명시적으로 쓴다.
- URL 순서: 고정 경로(`wait-counts/`, `export/`, `pharmacy-queue/`)를 `<int:pk>/`와 라우터 URL보다 **먼저** 둔다.
- 번호 발급·재고 차감처럼 동시 요청이 몰리는 곳은 `transaction.atomic()` + `select_for_update()`를 쓴다.
- 모델 필드: CharField/TextField는 `blank=True`, 그 외 타입에서 "값 없음"을 허용하려면 `null=True, blank=True`.
  이미 쓰이는 마스터/약품 FK는 `on_delete=PROTECT`, 표시용 참고 FK는 `SET_NULL`.
- 날짜 기준 필터는 "오늘"(`timezone.localdate()`)을 쓴다. 지난 날짜의 미처리 건이 현장 화면에 남지 않게 한다.
  `date.today()`는 서버 PC 시간대를 따라 `settings.TIME_ZONE`과 어긋날 수 있으니 쓰지 않는다.

**프론트엔드**
- API 호출은 반드시 `static/js/api.js`의 `apiFetch()`를 거친다(토큰 부착, 401이면 로그인 화면으로, 오류 메시지 가공).
- 사람이 입력한 문자열을 `innerHTML`에 넣을 때는 `escapeHtml()`을 거친다.
- 여러 페이지가 쓰는 화면 도우미(`escapeHtml`, `showToast`, `patientMeta`, `doctorLabel`, `byId`)는 `common.js`에만 둔다. 페이지 js에 다시 정의하지 않는다 — 일반 `<script>`끼리는 `const`·`let` 이름을 공유해서, `const byId`가 두 번 있으면 페이지 전체가 멈춘다.
- 디자인 토큰(색·반경·그림자)은 `base.css`의 `:root` 변수만 쓴다. 공통 컴포넌트(`.card`, `.field-input`, `.btn-primary`, `.toggle`, `.queue-item` 등)는 `base.css` 또는 공용 css에서 재사용하고 페이지마다 복제하지 않는다.
- 디자인 톤: **애플 스타일** — 여백 넉넉, 은은한 그림자, 둥근 모서리, 깔끔한 타이포. 등록번호만 점선 테두리 + `tabular-nums`로 "번호표" 느낌을 낸다. 못생기게 만들지 않는다.
- 확인·입력용 팝업은 브라우저 기본 `alert/prompt/confirm` 대신 `openModal()` / `closeModal()`과 `showToast()`를 쓴다.
- 목록을 폴링으로 갱신할 때: 응답을 JSON 문자열로 비교해 바뀐 경우에만 다시 그리고, 입력창에 포커스가 있으면 갱신을 미룬다.
- 목록 안에 펼쳐지는 패널(접수/진료)은 `#panel-dock`을 "집"으로 둔다. 목록을 `innerHTML`로 다시 그리기 전에 패널을 dock으로 옮겨 두지 않으면 패널이 사라진다.
- `hidden` 속성이 `display:flex` 클래스에 덮이지 않도록 `base.css`에 `[hidden] { display: none !important; }`가 있다. 지우지 않는다.
- 같은 specificity에서는 나중에 정의된 규칙이 이긴다. `.btn-primary`(width:100%)와 `.btn-inline`이 충돌했던 전례가 있어 `.btn-primary.btn-inline`처럼 더 구체적인 선택자를 쓴다.
- `<script>` 순서: 함수를 정의하는 파일이 호출하는 파일보다 **먼저**. 예: `api.js` → `common.js` → `patient-intake.js` → `nav.js` → `modal.js` → 페이지 js.
- 템플릿에서 CSS·JS는 `{% load static_version %}` + `{% static_v 'js/x.js' %}`로 불러온다(`{% static %}` 대신). 파일이 바뀌면 주소의 `?v=`가 바뀌어 모든 기기가 새 파일을 받는다. 새 페이지를 만들 때도 지킨다.
- 인라인 `style="..."`을 JS 문자열에 넣지 않고 css 클래스를 만든다(예: `.rx-cart-toggle`, `.empty-text.is-error`).

## 8. 작업 방식 (Claude에게)

- 사용자는 한 번에 크게 바꾸는 것보다 **단계별로 확인하면서** 진행하길 원하고, 직접 이해하고 유지보수할 수 있어야 한다. 변경 이유를 짧게 설명하고, 한 번에 여러 파일을 손댈 때는 어떤 파일의 어느 부분인지 분명히 알려준다.
- 큰 요구가 들어오면 먼저 화면 흐름과 DB·API 영향을 정리해서 확인받고 코드를 작성한다. 불확실한 업무 규칙(예: "진료 전"의 기준, 자동 취소 여부)은 추측하지 말고 묻는다.
- 기능을 만든 뒤에는 사용자가 따라 할 수 있는 확인 절차(curl 명령, 브라우저에서 눌러볼 순서)를 같이 준다.
- 사용자가 파일을 통째로 교체하길 원하는 경우가 많다. 수정이 여러 군데면 패치 조각 대신 최신 전체 파일을 준다.
- 문서(DB 설계·API 명세 등)는 Notion에 옮겨 쓴다. 큰 설계 변경이 생기면 문서도 같이 갱신한다.

## 9. 지금까지 완성한 부분

**백엔드 (전부 curl로 테스트 완료)**
- 모델 전체와 admin 등록, 커스텀 User, 토큰 8시간 만료 로그인/로그아웃(`is_superuser`, `current_missions` 포함)
- 안내·접수·진료·약국 4팀 API 전체, 역할 권한 클래스
- `management` 앱: 약품·카테고리·창고배치·미션재고 CRUD, 미션 탭 목록, 환자 통계, 미션 재고 정산, 엑셀 export(cat1별 시트)
- 페이지네이션 `page_size`, 의사 전문과 표시(`department_code`), 배정 취소, 접수 대기 기준 = 주호소
- 진료팀: 처방 수정·삭제, 전과·배정 취소(`assigned_by`), 진료 완료·완료 취소(`done_at`), 다른 의사 완료 처방 조회, 본인 배정·처방만 다루도록 객체 권한

**프론트엔드**
- 공통: 디자인 토큰, Pretendard 로컬 폰트, nav(관리자는 전체 메뉴), 범용 모달, 토스트, 반응형, 로그인·미션 선택·미션 없음 화면, 로그인 라우팅
- 안내팀 페이지 완료 (폰 실기기 테스트 완료)
- 접수팀 페이지 완료 (대기/완료 목록, 접수 폼, 의사 배정·취소, 읽기 전용, 환자 검색·신규 등록 모달, 환자정보 수정)
- 진료팀 페이지 완료: 진료 대기/오늘 진료 완료 목록, 진료 상세, vitals·병력·환자정보 수정, 다른 의사 배정 현황,
  새 처방 작성(진료과 선택, 분류·검색으로 약 탐색, 장바구니, 복용스케줄/수량 입력 전환, 약 없이 저장 가능),
  작성된 처방 수정·삭제(카드 편집 모드, 약 변경은 빼고 새 처방에서 다시 담기), 다른 의사 완료 처방 보기,
  전과 모달·배정 취소, 진료 완료(확인 모달 → 패널 닫힘)·완료 후 읽기 전용·완료 취소

## 10. 앞으로 할 일

**다음 작업**
- 약국팀 프론트엔드 (`feature/frontend-pharmacy`) — 1단계 백엔드, 2단계 조제 대기, 2-1단계 조제지 자동 출력 완료
  - 남은 것: 3단계 오늘 수령 완료 목록·수령 취소 → 4단계 재고·통계(이때 탭: 조제 | 재고 | 통계)
  - 조제지 실제 프린터 출력은 아직 못 해 봤다(프린터 미정, A4 기준). 현장 프린터가 정해지면 `--kiosk-printing`과 용지에 맞춰 확인한다.

**그 이후**
- 관리자 프론트엔드 (미션 탭 통계, 약품/배치/미션재고 CRUD 화면, 정산, export 다운로드)
  - 시간대 설정 화면: `SiteConfig`(행 1개, `time_zone`) 모델 + 요청마다 `timezone.activate()`하는 미들웨어 + 관리자 화면에서 선택.
    같은 화면에 "서버 기준 오늘 날짜·현재 시각·시간대"를 보여줘 설정 실수를 바로 알아보게 한다. 미션 중 변경은 확인 모달.
- 약품 리스트 엑셀(`약품_리스트_아가페_2026_약품분류용1.xlsx`)을 `Drug`/`DrugCategory`/`DrugBatch`로 가져오는 `import_drugs` 관리 커맨드 (시트: 약속처방, 경구, 외용약, 비타민, 주사제, 소아, 추가약)
- 진료 차트 양식(`고객등록카드(캄보디아) - 2025.hwp`)에 있는 치과 차트(Primary/Permanent teeth) 모델과 화면
- 수술팀 워크플로우, 통계 문서 저장(PDF/엑셀) 같은 부가 기능
- 환자용 그림 복용지도(아침/점심/저녁, 식전/식후 그림). 지금 처방에는 1회량·1일 횟수·일수와 약의 `usage` 글자뿐이라, 복용 시점을 처방 입력에 먼저 추가해야 한다.
- 약국 조제 화면의 [의사에게 돌려보내기] 버튼(재고가 없어 처방을 바꿔야 할 때). 지금은 약국팀이 의사에게 말로 전하고 의사가 [완료 취소]한다.

**보류 중인 개선**
- 한 사람이 동시에 두 미션에 배정된 경우, 선택한 미션을 서버에 반영하는 로직이 없다(현재는 항상 첫 번째 미션 사용). 화면(`/select-mission/`)만 있다.
- 접수 기록 읽기 전용을 서버에서도 강제(`VisitVitalsUpdateView`에 검증 추가).
- 누가 언제 무엇을 수정했는지 남기는 감사 로그(audit log).
- 어제 이전의 미처리 배정을 자동으로 정리할지(현재는 오늘 날짜만 화면에 보여주고 DB에는 남긴다).
- `Prescription`에 작성자 필드가 없어 "그 처방이 달린 배정의 의사"를 작성자로 본다. superuser가 대신 쓴 처방도 배정 의사 것으로 잡힌다.
- 안내팀(`info.js`)은 아직 `common.js`를 쓰지 않고, 오류 메시지를 escape 없이 `innerHTML`에 넣는 곳이 있다.

## 11. 주의사항 (알려진 함정)

- **코드가 기준이다.** Notion에 옮긴 설계 문서(`EMR_DB_설계`, `EMR_페이지_기능명세`, `EMR_API_공통구조`, `EMR_API_명세`)는 일부 오래됐다. 문서에 없고 코드에만 있는 것: `MissionStock`/`DrugBatch` 분리와 `source_detail`, `uses_dosage_schedule`, `User.primary_department`, 접수 대기 기준(맥박 → 주호소), 배정 취소 DELETE, 진료팀용 처방약 수정 URL,
  `VisitDepartment.assigned_by`/`done_at`, 처방 수정·삭제 API, 진료 완료 규칙, 진료팀 본인 배정 권한.
- **시간대**: `settings.TIME_ZONE` 기본값은 개발 장소인 `Asia/Seoul`이다. 현장에서는 `config/local_settings.example.py`를 `config/local_settings.py`로 복사해 그 나라 시간대(캄보디아 `Asia/Phnom_Penh`)로 바꾼다(git 제외 파일).
  깜빡하면 한국 시간으로 돌아가서 시각 표시가 어긋나고 밤늦게 날짜가 넘어간다. 시각은 DB에 UTC로 저장되므로 시간대를 바꿔도 지난 기록은 틀어지지 않는다.
- **`PrescriptionDrug.save()` 자동 계산**: PATCH로 `quantity`만 보내도 세 값(1회량·횟수·일수)이 있으면 덮어쓴다. 약국팀 수정은 `PrescriptionDrugUpdateSerializer.update()`에서 `instance.save(skip_recalculate=True)`를 직접 호출한다.
  `serializer.save(skip_recalculate=True)`처럼 kwarg로 넘기면 DRF가 데이터로 취급해서 동작하지 않는다.
- `POST /visits/` 응답에는 `assignments`가 없다. 방문을 만든 직후 그 응답을 접수 화면 상태에 넣을 때 `assignments = []`를 직접 채워야 한다.
- 접수 폼 맥박(`pr`)은 선택이다. "접수 대기" 판단에 `pr`을 쓰지 않는다(주호소 기준).
- `runserver` 자동 재시작은 여러 .py 파일을 연달아 고치면 일부 변경을 놓칠 수 있다. 백엔드를 고쳤는데 API 응답이 그대로면 `runserver`를 직접 껐다 켠다(`manage.py shell`은 디스크 코드를 새로 읽어서 정상으로 보이니 헷갈리기 쉽다).
- 브라우저 캐시: `{% static_v %}` 덕분에 고친 JS·CSS는 일반 새로고침으로 새로 받는다. 이미 열려 있던 화면은 새로고침 전까지 예전 파일을 쓴다. 그래도 안 먹힌 것처럼 보이면 `Ctrl+Shift+R`.
  (페이지 js끼리 `const` 이름이 겹치면 SyntaxError로 페이지 전체가 멈추니, 옛 파일과 새 파일이 섞인 것처럼 보이면 먼저 새로고침해 본다.) 계정을 바꿔 테스트할 때는 로그아웃 후 재로그인한다(`localStorage`에 이름·권한이 남는다).
- Windows cmd에서 curl로 한글 파라미터를 보낼 때는 `curl -G <URL> --data-urlencode "search=한글"`을 쓴다. 헤더는 `Authorization: Token <키>`(`Token` 단어와 공백 필수).
- 개발용 설정이 남아 있다: `ALLOWED_HOSTS = ['*']`, `DEBUG = True`. 현장 배포 전에 `config/local_settings.py`에서 허용 IP를 좁히고 `DEBUG = False`, 새 `SECRET_KEY`를 넣는다.
- SQLite 한 파일에 여러 기기가 동시에 쓴다. SQLite는 `select_for_update()`를 무시하므로 `settings.py`의 DB 옵션 `transaction_mode: IMMEDIATE`(+ `timeout: 20`)로
  `transaction.atomic()`이 시작할 때 쓰기 잠금을 잡게 했다. 이 옵션이 없으면 동시 방문 등록 10건 중 8건이 `database is locked` 500으로 실패했다.
  번호 발급·재고 차감처럼 겹치기 쉬운 곳은 반드시 `transaction.atomic()` 안에서 읽고 쓴다(`select_for_update()`는 다른 DB로 옮길 때를 위해 그대로 둔다).
- 테스트용 계정 비밀번호·토큰은 문서나 커밋에 적지 않는다.
- Role 이름이나 Department 약어를 admin에서 바꾸면 코드의 문자열 비교(`'진료팀'` 등)와 어긋날 수 있다. 바꾸기 전에 코드를 같이 확인한다.
