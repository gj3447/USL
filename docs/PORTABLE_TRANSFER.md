# USL 이동 계약 — PT01 진행 기록

다른 기기와 디렉터리에서도 같은 자원을 가리키기 위한 첫 단계다. 선택형 `usl/portable-transfer` 모듈에 **고정 자원 정체성·버전 이력·payload 상대 위치를 분리하는 순수 계약**을 구현했다. 실제 파일 복사, 백업 생성, 복원 명령은 후속 PT02·PT03에서 구현한다.

[최초 작업 계획](PORTABILITY_PLAN.md)은 계획 당시의 상태를 보존한다. 이 문서와 [로컬 계약 검사 영수증](../research/portable-transfer/contract.receipt.json)이 그 이후의 PT01 진행을 기록한다. 영수증은 실행한 테스트와 파일별 해시를 연결하며, 기기 간 복원 인수검사나 형식 증명을 뜻하지 않는다.

## 가능 범위와 완료 기준

| 요구사항 | 구현 판단과 조건 |
|---|---|
| 컴퓨터·작업경로 변경 후 연결 유지 | 가능. `(ownerNamespace, nativeId)`를 보존하고 새 기기의 로컬 위치를 명시적으로 연결한다. |
| 백업에서 메모리·작업환경 복원 | 가능. 복원에 필요한 파일·owner 제공 snapshot이 남아 있고 무결성 검사를 통과해야 한다. 실제 export/import는 PT02·PT03이다. |
| 두 기기에서 동시에 수정 | 분기와 충돌 보존은 가능. 의미가 충돌하는 내용을 항상 자동으로 올바르게 합치는 것은 보장하지 않는다. |
| 끊긴 네트워크에서도 작업 | 선택한 역사 버전에서 작업 가능하도록 설계한다. 다른 기기의 최신 상태를 확인하지 못하면 전역 최신성은 `UNKNOWN`이다. |
| 모든 원본·백업 소실 후 복구 | 남은 복구 정보가 없으면 보장할 수 없다. 동기화와 별도 보존 백업을 구별한다. |
| 규칙 강도와 HSWM W 연계 | 규칙 우선순위·추천 가중치 연결은 가능하다. 가중치가 파일 정체성·무결성·owner 권한 검사를 통과시켜 주지는 않는다. |

이 판단은 로컬 코드와 [표준 조사 및 적용 한계](PORTABILITY_PLAN.md#표준-적용과-남은-선택)에 근거한 구현 판단이다. BagIt·OCFL 전체 준수, 모든 OS·파일시스템의 이동 성공, 연결되지 않은 owner의 최신성은 아직 검증하지 않았다.

## PT01 데이터 모델

| 항목 | 식별 또는 값 | 해석 |
|---|---|---|
| Resource | `ownerNamespace` + `nativeId` | 기존 owner의 ID를 그대로 쓴다. 같은 bytes여도 별개 자원일 수 있다. |
| Revision | 전역 IRI `id`, `resource`, `parents`, `issuer`, `kind` | 부모 관계로 분기를 표현한다. 기기 시각으로 최신 revision을 고르지 않는다. |
| Representation | 전역 IRI `id`, `revision`, byte digest·길이 | 특정 content revision의 표현이다. 원문 검사는 PT02·PT03에서 실제 bytes로 수행한다. |
| Location | representation의 `payloadPath` | 번들 내부 상대 위치다. 자원 ID가 아니며 실제 기기의 root·자격증명을 포함하지 않는다. |
| Tombstone | `kind: TOMBSTONE`, 동일 자원의 부모 revision | 해당 이력에서의 삭제 표시다. live representation을 가질 수 없고 최신 삭제 상태를 자동 증명하지 않는다. |
| Fork | 새 resource ID + `derivedFrom` | 기존 자원에서 분기한 별개 자원을 명시한다. 같은 내용의 자동 합치기는 없다. |
| 관측·발행 선언 | `observedAt`, `issuer` | UTC 관측 시각·발행자 참조에 대한 선언이다. 인증된 서명이나 owner의 현재 상태 조회가 아니다. |

v1 manifest는 하나의 owner namespace만 담는다. native ID는 최대 256자이며 공백·한글·콜론을 보존하고 제어문자는 거부한다. revision/representation ID는 최대 512자의 IRI다. 선언된 ID가 기존 저장소와 충돌하는지 검사하는 것은 복원 소비 프로그램의 후속 책임이다.

`historyBoundary.mode: CLOSED_V1`은 포함된 revision의 부모가 manifest 안에 있거나 명시적인 외부 경계 pin으로 선언되어야 한다는 뜻이다. 경계에는 revision ID, 자원 정체성, `USL_CONTRACT_SHA256_V1`으로 계산한 revision descriptor digest가 들어간다. 제외된 부모 descriptor와 그 조상은 여기서 조회·검증하지 않는다. 따라서 이것은 **전체 역사나 payload 보존의 증명은 아니다**. orphan pin, 이력 cycle, 허용하지 않은 자원 간 부모 연결은 거부한다.

JSON 입력은 2 MiB, 자원 1,024개, revision·representation 각각 4,096개, revision당 부모 64개로 제한한다. 번들 내부 경로는 ASCII 영문·숫자·점·밑줄·하이픈으로 된 경로 성분과 `/`만 허용한다. 절대경로, traversal, Windows 예약명, 대소문자 및 파일/디렉터리 충돌은 거부한다. 원래 파일명·native ID가 한글이어도 exporter가 ASCII payload 이름으로 매핑할 수 있다. 원본 이름을 복원하는 매핑은 PT02에서 정의한다. 이 제한은 전체 OS 경로 호환성 검사 완료를 뜻하지 않는다.

## 무결성과 권한의 분리

`SHA256_RAW_BYTES_V1`은 실제 payload bytes의 SHA-256이다. `USL_CONTRACT_SHA256_V1`은 기존 `contractDigest`의 정렬된 객체 키·순서가 있는 배열·JSON 값 직렬화에 대한 SHA-256이다. RDF 정규화나 임의의 의미 동등성 판정이 아니며 기존 digest 동작을 바꾸지 않는다.

envelope는 manifest 본문의 digest를 본문 밖에 둔다. `checkPortableTransferManifest`에는 호출자가 별도로 알고 있는 `expectedManifestDigest`와 `allowedOwnerNamespace`를 전달한다. 번들에서 읽은 digest를 그대로 기대값으로 넣으면 독립적인 출처 확인이 되지 않는다. 이 함수는 manifest 내용과 pin을 검사하고 다음 상태만 반환한다.

```text
manifest: CHECKED
payload: NOT_CHECKED
freshness: UNKNOWN
authority: NOT_GRANTED
execution: NOT_REQUESTED
```

백업을 읽을 수 있다는 사실과 현 기기의 실행 권한은 별개다. PT01 API는 파일·네트워크·자격증명 저장소에 접근하지 않는다.

## 표준 그래프와 실행 근거

[JSON Schema](../schemas/portable-transfer/manifest.schema.json)는 strict 구조와 값 범위를 기술한다. ID 참조·DAG·경로 충돌·digest 일치는 TypeScript parser가 추가 검사한다. JSON Schema만 통과했다고 전체 의미 검증이 끝난 것은 아니다.

[합성 manifest](../research/portable-transfer/envelope.json)와 [RDF/JSON-LD 그래프](../research/portable-transfer/graph.jsonld)는 같은 bytes digest를 가진 두 자원을 별개 노드로 유지하고, revision → resource 및 representation → revision을 연결한다. `prov:Entity`, `prov:Agent`, `prov:wasAttributedTo`는 출처 선언에 사용한다. resource의 그래프 IRI는 owner/native ID 튜플의 해시이며 **내용 해시 기반 자원 병합이 아니다**. 이 합성 그래프는 일반 manifest의 RDF exporter 구현을 주장하지 않는다.

[SHACL](../schemas/portable-transfer/manifest.shacl.ttl)과 독립 Python 검증기는 관계의 타입·cardinality, 삭제 표현, 이력 cycle 및 SPARQL 조회 결과를 검사한다. 조회 결과는 원본 manifest의 정확한 endpoint 집합과 비교한다. 테스트 fixture의 payload는 실제 백업 파일이 아니며 파일 무결성 검사를 수행한 것으로 기록하지 않는다.

```sh
npm run portable-transfer:build
npm run portable-transfer:record
npm run portable-transfer:check
npm run portable-transfer:standards
```

`build`는 합성 그래프와 schema를 생성한다. `record`는 로컬 계약 테스트를 실제 실행해 영수증을 갱신한다. `check`는 생성물과 기록된 source pin을 대조하며 과거 테스트를 다시 실행했다고 주장하지 않는다. Python 의존성은 `scripts/requirements-standards.txt`에 고정되어 있다.

다음은 PT02의 bounded snapshot/export다. 실제로 복사한 bytes의 해시·크기를 기록하고, owner DB snapshot과 Git 외부 payload 등 내보낼 수 없는 범위를 명시한 뒤 PT03의 새 목적지 복원으로 이어간다.
