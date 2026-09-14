# USL: 추가로 연결해야 할 대상과 설계 사각지대

2026-09-08 · Codex + 독립 조사 에이전트 3개 · T0 조사 · SECONDARY_AI 설계 제안

사용자 원문: “미처 생각못한 연결해야하는 다른 것은 없는지 검색좀 해줘봐봐 ㅇ”.

기준은 KG·Git 저장소·URL·파일시스템을 의미로 연결하는 USL이다. KG의 `sym:Concept:usl`을 조회했고, [앞선 선행 기술 조사](RESEARCH_SEMANTIC_ADAPTERS_2026-09-07.md)에서 상대적으로 덜 구체화한 연결 대상을 추가 조사했다. 아래 범주는 사용자 정전의 확장이 확정되었다는 뜻이 아니다. 공식 규격과 프로젝트 문서의 사실을 근거로 연결 후보를 제안한다. 모든 분야를 망라한 목록이나 구현 완료 목록은 아니다.

## 핵심 발견

추가로 필요한 축은 **실행 인스턴스와 활동, 데이터의 논리 객체와 부분, 사람과 권한, 사건과 시간, 현실의 측정 대상**이다. 여기에 USL의 연결·어댑터·검사 규칙 자체도 참조 대상으로 포함할 것을 제안한다.

어떤 대상이 URL이나 파일로 노출된다고 해도 그 의미가 같아지는 것은 아니다. 모델 파일과 모델을 사용한 실행, 서비스 주소와 서비스의 현재 프로세스, 테스트 코드와 특정 실행 결과는 서로 다른 자원이다. USL은 자원을 공통 방식으로 지칭하면서 이런 구분과 관계를 보존해야 한다.

## 1. 데이터·AI에서 연결할 대상

각 행의 연결 예와 USL 적용 판단은 AI 제안이다. 링크는 해당 자원 모델을 확인한 1차 자료다.

| 추가 대상 | 연결 예 | 보존할 구분 / 근거 |
|---|---|---|
| **DB 테이블·뷰·열·행** | KG의 ‘활성 사용자’ → view 정의 → 원본 table/column → 특정 key의 row | DB 주소는 데이터 객체 전체의 식별이 아니다. 행 번호보다 소스 범위와 key를 사용하고, key가 없으면 관측한 결과 내의 행으로 한정한다. 테이블·열 수준 계보의 선례: [OpenLineage](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md). |
| **질의와 결과 집합** | SQL 정의 + 매개변수 → query run → result set → 분석 주장 | 질의 텍스트, 실행, 결과를 분리한다. 같은 질의도 입력 snapshot·binding·실행 맥락에 따라 다른 결과를 낸다. job/run/input/output 구분의 선례: [OpenLineage](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md). |
| **데이터셋 snapshot·partition·schema field** | 학습 실행 → 사용한 table snapshot → 선택한 partition과 field | 폴더 위치와 논리적 table 상태를 분리한다. Iceberg는 table UUID, schema, snapshot, manifest 등을 구분한다. snapshot 만료 후 참조와 실제 가용성도 다를 수 있다. [Iceberg 명세](https://iceberg.apache.org/spec/). |
| **노트북 셀과 셀 실행·출력** | KG 주장 → notebook revision의 cell → execution → 계산 출력 | 셀 위치와 셀 ID, source와 저장된 output을 구분한다. 셀 ID는 notebook 범위에서 사용하고 실행 환경·source revision을 결합한다. [nbformat 4.5 schema](https://github.com/jupyter/nbformat/blob/main/nbformat/v4/nbformat.v4.5.schema.json). |
| **모델과 실행에 필요한 묶음** | 배포 → model package/version → 가중치·구성·환경·전처리 자원 | 모델을 파일 경로 하나로 축약하지 않는다. 어떤 구성 요소를 묶을지는 모델 driver 계약으로 정한다. MLflow는 모델 형식과 관련 산출물·의존 환경을 패키지로 기술한다. [MLflow Models](https://mlflow.org/docs/latest/ml/model/). |
| **프롬프트와 실제 추론 실행** | prompt template/version + 채운 입력 + 모델 → inference run → 응답 | template과 rendered input, 모델 별칭과 관측한 모델 버전, 도구 호출 맥락을 구분한다. [MLflow prompt/model 연결](https://mlflow.org/docs/latest/genai/prompt-registry/log-with-model/), [trace 평가](https://www.mlflow.org/docs/latest/genai/eval-monitor/running-evaluation/traces/). |
| **RAG 문서 조각·임베딩·인덱스·검색 결과** | 원문 revision → chunk → embedding → index → retrieval run → 응답의 참조 근거 | vector ID만으로 원문 위치·chunking 규칙·embedding 모델을 복원할 수 있다고 가정하지 않는다. named vector와 모델 교체의 실제 사례: [Qdrant migration](https://qdrant.tech/documentation/tutorials-operations/embedding-model-migration/). |
| **학습·평가 실행과 평가 기준** | 데이터 snapshot + 코드/config → training run → checkpoint → eval run → 점수 | 모델, 평가 데이터 split, scorer와 기준 버전, 실행 결과를 연결한다. 점수만 저장하면 무엇을 평가했는지 잃는다. [MLflow Tracking](https://mlflow.org/docs/latest/ml/tracking), [trace 기반 평가](https://www.mlflow.org/docs/latest/genai/eval-monitor/running-evaluation/traces/). |

이 축에서 새로 필요한 공통 계약은 **활동의 입력/출력, 실행 ID, snapshot, 부분 선택**이다. SQL·모델·벡터DB별 구문을 USL 코어에 직접 추가할 필요는 없다. 구체 descriptor와 검사는 버전 있는 driver schema로 확장한다. ML 도구를 참고하는 것이 USL 구현 언어를 Python으로 바꾸자는 뜻은 아니다.

## 2. 소프트웨어를 실행·운영할 때 연결할 대상

| 추가 대상 | 연결 예 | 보존할 구분 / 근거 |
|---|---|---|
| **빌드·패키지·의존성·생성 근거** | Git commit + build config + dependencies → build run → binary/image → provenance | 코드와 그 코드로 만들어졌다고 주장되는 산출물을 분리한다. SLSA는 buildDefinition과 runDetails를 구분하고 산출물 subject와 연결한다. [SLSA provenance v1.1](https://slsa.dev/spec/v1.1/provenance). 구성요소·서비스·제조/배포 과정 모델: [CycloneDX](https://cyclonedx.org/specification/overview/). |
| **프로세스·컨테이너·호스트 실행 인스턴스** | image → container instance → process → socket | 이미지 내용 식별과 실행 수명을 분리한다. OCI container ID는 host 범위에 속하고 삭제 뒤 재사용될 수 있다. PID·포트 역시 단독 영구 ID로 쓰지 않는다. [OCI runtime](https://github.com/opencontainers/runtime-spec/blob/main/runtime.md), [OCI descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md). |
| **VM·가상 하드웨어·복원/복제된 실행 상태** | VM 정의/UUID → 실행 guest → disk snapshot/복원 → guest 내부 process | 논리 VM, 실행 ID, guest 상태, host의 접근 주소를 분리한다. libvirt는 name·uuid·실행 id와 별도로 복원·복제 등에 대한 generation ID를 기술한다. 동일 VM 참조가 동일 실행 이력을 뜻한다고 가정하지 않는다. [libvirt Domain XML](https://libvirt.org/formatdomain.html#general-metadata). |
| **원하는 구성과 실제 배포 상태** | Git config → Deployment의 spec → controller 관측 → Pod UID | name/UID, spec/status, 선언된 세대와 관측한 상태를 분리한다. 삭제·재생성된 동명 객체는 새로운 대상일 수 있다. [Kubernetes object names/UIDs](https://kubernetes.io/docs/concepts/overview/working-with-objects/names/), [Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/). |
| **논리 서비스·DNS·실제 endpoint** | 서비스 → 공개 이름/주소 → 특정 시각의 backend 목록 → 실행 인스턴스 | 하나의 주소가 여러 backend로 이어지며 대상은 바뀐다. IP·DNS·Service·Pod를 `sameAs`로 합치지 않는다. [Kubernetes Service](https://kubernetes.io/docs/concepts/services-networking/service/), [EndpointSlices](https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/). |
| **워크플로 정의·실행·재시도** | workflow version → run → task attempt → job/process → output | 계획과 실행, 실패한 시도와 재시도, 성공 조건과 실제 종료를 구분한다. [Kubernetes Job](https://kubernetes.io/docs/concepts/workloads/controllers/job/), [OpenLineage Job/Run](https://github.com/OpenLineage/OpenLineage/blob/main/spec/OpenLineage.md). |
| **이벤트·메시지·스트림 위치** | 실행 → emitted event → topic/queue → delivery → consumed-by run | 사건, 운반 채널, 전달·수신 기록을 구분한다. CloudEvents의 source+id 범위와 별도로 broker cursor/offset은 해당 broker 계약을 따른다. [CloudEvents](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md). |
| **trace·span·log·metric** | API 요청 → 분산 span → 특정 서비스 실행 → 오류 로그 → 관련 코드 revision | telemetry는 관측 근거다. metric 집계나 일부 수집된 span을 전체 실행 이력으로 해석하지 않는다. [OpenTelemetry 명세](https://opentelemetry.io/docs/specs/otel/), [resource conventions](https://opentelemetry.io/docs/specs/semconv/resource/). |

이 축에서 빠뜨리기 쉬운 것은 **수명과 범위**다. host·cluster·namespace·실행 세대가 빠진 짧은 ID는 다른 대상을 가리킬 수 있다. `desired`, `observed`, `generated`, `executed` 같은 관계를 구분하되 구체 단어와 상태 전이는 각 vocabulary와 driver가 정의하도록 제안한다.

## 3. 화면·문서·업무 맥락에서 연결할 대상

| 추가 대상 | 연결 예 | 보존할 구분 / 근거 |
|---|---|---|
| **브라우저 탭·문서·DOM 요소·현재 화면 상태** | 사용자 작업 → browsing context → 문서의 입력 요소 → UI action → 결과 관측 | URL만으로 현재 로그인/문서/화면 맥락이나 특정 요소를 식별할 수 없다. WebDriver BiDi는 browsing context, realm, node의 shared reference 등을 구분한다. 수명이 끝난 handle을 영구 ID로 쓰지 않는다. [WebDriver BiDi 2026-03-09 Working Draft](https://www.w3.org/TR/2026/WD-webdriver-bidi-20260309/). |
| **PDF 페이지·이미지 영역·영상/음성 구간·자막** | KG 주장 → 특정 페이지 영역 또는 영상 12–18초 → 전사·주석 | 파일 전체, 공간 영역, 시간 구간, 표현 버전을 구분한다. IIIF Canvas는 공간·시간의 기준을 제공하고 fragment/annotation으로 부분을 연결한다. [IIIF Presentation 3.0](https://iiif.io/api/presentation/3.0/). |
| **메시지·답글·스레드·결정 출처** | 요구사항/결정 → 원문 메시지 → 답글·개정 메시지 → 참여 주체 | 문서화된 해석과 사용자 원문을 분리하고 서비스별 object ID·관측 버전을 남긴다. 메일의 Message-ID/References 선례: [RFC 5322](https://www.rfc-editor.org/rfc/rfc5322.html). 활동·대상·답글 모델: [ActivityStreams Vocabulary](https://www.w3.org/TR/activitystreams-vocabulary/). |
| **일정·반복 일정의 개별 회차·할 일** | 예정 작업 → 특정 회차 → 실행 기록/회의 결정 | 반복 시리즈와 개별 회차, 예정과 실제 수행을 구분한다. iCalendar는 UID·RECURRENCE-ID·SEQUENCE 등을 통해 이를 식별한다. [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html). |
| **요구사항·테스트 케이스·실행 결과·분석 finding** | requirement → test case → test result → 대상 코드 revision/영역 | 테스트 정의와 실행 판정, 분석 rule과 finding을 구분한다. 통과한 특정 시험을 모든 의미의 증명으로 확대하지 않는다. [OSLC QM 2.1](https://docs.oasis-open-projects.org/oslc-op/qm/v2.1/os/quality-management-spec.html), [SARIF 2.1.0 + Errata 01](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html). |

스프레드시트의 셀·이름 있는 범위, 슬라이드의 도형, 편집기의 저장 전 문서도 같은 **부분 선택 + 세션/버전 범위** 확장으로 다룰 후보다. 이 문장은 IIIF나 WebDriver가 해당 앱 전체를 지원한다는 주장이 아니라 USL 설계의 유추다. 앱별 API/식별 계약의 추가 조사가 필요하다.

## 4. 사람·권한·물리 세계에서 연결할 대상

| 추가 대상 | 연결 예 | 보존할 구분 / 근거 |
|---|---|---|
| **사람·조직·계정·에이전트·그룹** | 사람 → 조직 소속/계정 → 실행 agent → 실행 기록 | 이름·계정·실제 주체를 구분한다. SCIM의 사용자/그룹 모델과 DID의 identifier/control 모델은 서로 역할이 다르며, 그룹 소속만으로 모든 권한이 결정되지는 않는다. [RFC 7643](https://www.rfc-editor.org/rfc/rfc7643.html), [DID Core](https://www.w3.org/TR/did-core/). |
| **권한·위임·승인·적용 정책** | 주체 → 위임/승인 → 허용 action/target 범위 → 실행 | 정책 설명과 실제 인가 집행을 구분한다. 서명·계정 식별·의미 주장 승인 역시 별개다. 원문 승인이나 관련 근거가 있으면 대상·범위·유효 기간과 함께 참조한다. [ODRL 2.2](https://www.w3.org/TR/odrl-model/), [OAuth Token Exchange RFC 8693](https://www.rfc-editor.org/rfc/rfc8693/). |
| **실물·장치·센서·작동기·배치 위치** | 장치 → 설치 장소/측정 대상 → 측정 절차 → 관측 결과 | 장치와 현재 배치, 센서와 관측 대상, 읽기와 작동을 구분한다. [SSN/SOSA 2017 Recommendation](https://www.w3.org/TR/2017/REC-vocab-ssn-20171019/), [OGC SensorThings](https://www.ogc.org/standards/sensorthings/). |
| **좌표·영역·측정량·단위·교정** | 측정 결과 → quantity kind/unit → calibration revision → 실제 대상/영역 | 숫자나 좌표만으로 의미를 정하지 않는다. 단위와 좌표 기준, 적용 조건을 보존한다. [GeoSPARQL 1.1](https://docs.ogc.org/is/22-047r1/22-047r1.html), [UCUM](https://ucum.org/ucum), [QUDT](https://www.qudt.org/catalog/qudt-catalog.html). |

시간은 공통으로 필요하다. **발생 시각, 시스템이 관측·기록한 시각, 주장이 유효한 기간**을 구분한다. 필요하면 timezone·시간 기준·구간 경계도 명시한다. 시간 구간과 관계의 교환 vocabulary로 [OWL-Time의 2017 Recommendation](https://www.w3.org/TR/2017/REC-owl-time-20171019/)을 참고할 수 있다. 모든 자원에 좌표나 권한 필드를 강제할 필요는 없으며 해당 의미나 동작에 필요한 맥락만 요구한다.

## 5. USL 연결 자체도 연결 대상으로 — AI 제안

이것은 특정 외부 표준의 기능을 그대로 서술한 것이 아니라, 위 조사와 기존 claim/evidence 모델에서 도출한 설계 제안이다.

- **연결 주장 → 근거/반례:** 어느 실행·문서·원문이 이 관계를 뒷받침하거나 반박하는가.
- **연결 주장 → 개정/승인:** 누가 무엇을 승인했으며, 이전의 어느 주장을 대체한다고 선언했는가.
- **어댑터 → 구현 코드/산출물:** 어떤 commit·패키지·build로 만들어졌는가.
- **어댑터 → 의미 모듈/검사 규칙:** 어느 계약 버전을 구현하며 무엇을 검사한다고 선언하는가.
- **실행 → 어댑터 버전 → 판정:** 같은 입력에서 driver가 바뀌어 결과가 달라졌는가.

즉 claim, 의미 모듈, adapter manifest와 검사 규칙도 식별 가능한 자원이어야 한다. 그래야 연결을 수정하거나 driver를 교체했을 때 어떤 근거와 판정이 영향을 받는지 추적할 수 있다. 순환 참조가 가능해진다고 순환 논증까지 허용하는 것은 아니다. 관계 참조와 정당화 규칙을 구분한다.

## 6. 코어에 필요한 것과 driver로 확장할 것 — AI 제안

새 자원 이름마다 예약어를 만드는 대신 다음 계약을 공통 메타모델에서 표현하는 편이 적절하다. 이것이 모두 새 표면 문법이나 필수 최상위 선언이어야 한다는 뜻은 아니다.

| 공통 계약 | 필요한 이유 | 구체화할 driver/vocabulary |
|---|---|---|
| **범위가 있는 참조** | 같은 PID·name·row key·짧은 ID가 서로 다른 시스템에 존재 | host, cluster, namespace, database, document, session 등 |
| **snapshot과 부분 선택** | 자원 전체와 특정 상태·부분을 구분 | DB key/column, notebook cell, DOM node, 이미지 영역, 시간 구간 |
| **활동·실행·시도와 입력/출력** | 코드/계획과 실제 동작을 연결 | build, query, inference, training, eval, workflow |
| **상태·사건·시점/기간** | 짧은 수명, 재시도, 변경, 관측 지연을 표현 | process lifecycle, event delivery, 배포 status, 유효 기간 |
| **주체와 실행 맥락** | 누가 주장했고 누구의 권한으로 실행했는지 구분 | 계정, 조직, agent, policy, delegation |
| **식별 가능한 주장과 근거** | 관계의 출처·반례·개정·평가 범위를 보존 | provenance, trace, test result, 원문 메시지, 승인 |

구체 타입·주소·상태 전이·프로토콜은 driver가 제공하고, 향후 USL 코어가 참조·타입·효과·근거 계약을 검사하도록 설계할 것을 제안한다. 외부 접근·watch·호출은 TypeScript + Effect의 실행 계층에 둘 제안이다. 이 조사를 이유로 임의의 외부 호출·KG 변경·자동 승인 동작을 추가하지 않는다.

## 7. 먼저 확인할 세 연결 사례 — AI 제안

1. **공학 실행:** KG 개념 → Git commit → build run → image digest → container/process → 요청 trace → test/오류 결과. 연결 근거의 코드 버전과 실행 시각이 실제로 보존되는지 본다.
2. **AI 응답 근거:** 원문 snapshot → chunk → embedding/index → retrieval run → prompt/inference run → 응답 → eval. 원문 변경이나 모델/평가기 교체가 어느 연결에 영향을 주는지 본다.
3. **사용자 결정의 출처:** 원문 메시지 → 특정 claim에 대한 결정 → 적용한 규칙 → adapter 실행 → 결과. 원문·AI 해석·기술적 관측·권한 판단을 각각 참조할 수 있는지 본다.

이 세 사례에 필요한 공통 계약을 먼저 설계하면, 이후 UI·일정·물리 장치도 같은 방식으로 추가할 여지가 생긴다. 현재 runtime v0.3/language v0.1의 지원 범위는 [LANGUAGE.md](LANGUAGE.md)와 README에 있으며, 이 문서는 추가 조사와 설계 후보다. 이번 변경은 조사 문서와 문서 링크뿐이고 새 driver·문법·KG 정전은 구현하거나 갱신하지 않았다.
