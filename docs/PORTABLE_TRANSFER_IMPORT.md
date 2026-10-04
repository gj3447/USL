# PT03 · 파일 백업 복원과 로컬 재바인딩

`usl/portable-transfer-import`는 [PT02 exporter](PORTABLE_TRANSFER_EXPORT.md)가 만든 파일 묶음을 검사하고 새 디렉터리에 복원한다. `usl/portable-transfer-bindings`는 검증된 결과를 기존 USL 바인딩·그래프의 선택한 로컬 표현에 연결한다. 원본 owner/native ID, revision ID, representation ID와 그래프의 참여 역할을 보존한다.

현재 지원하는 범위는 **`PINNED_FILES`**다. Git 저장소·linked worktree 전체를 재구성하는 기능은 아직 없으며 `GIT_WORKTREE`와 외부 필수 의존성이 남은 묶음은 거부한다. 따라서 계획의 PT03-C5 중 Git 재구성은 미완료다. [개발 진행](DEVELOPMENT_PROGRESS.md)에서 구현·거부 검사·미실행 플랫폼을 구분한다.

## 독립적인 입력과 무결성

`importPortableTransfer`에 `schema: "usl-portable-transfer-import/v1"`, `bundlePath`, `destinationParent`, `destinationName`, **`expectedReceiptDigest`**, **`allowedOwnerNamespace`**를 전달한다. 마지막 두 값은 owner가 독립적으로 정한 기준이다. 번들 안에서 읽은 digest를 그대로 기대값으로 쓰면 독립적인 확인이 되지 않는다.

완료 receipt의 실제 bytes, 여섯 sidecar의 해시·길이, PT01 manifest·envelope, inventory·policy·dictionary·schema의 대응, payload 전체의 해시·길이를 검사한다. 입력 schema가 맞아도 파일 누락·추가, ID 대응 오류, 가짜 PACKAGED 의존성, 복원 경로 충돌이 있으면 거부한다. 메타데이터의 해시가 맞는다는 이유로 그 안의 선언을 무조건 수용하지 않는다.

receipt와 policy의 snapshot ID는 일치해야 하며 owner 일관성 선언도 해당 snapshot profile의 허용값이어야 한다. 복원 경로에는 exporter와 같은 보호 정책을 적용해 `.git`, `.ssh`, `.aws`, `.npmrc`, `.gitconfig`, `.netrc`, `.env`, `.env.*` 구성요소를 거부한다. 해시를 다시 고정해도 이 의미·경로 검사를 생략하지 않는다.

의존성과 alias 목록은 각각 최대 1,024개이며 의존성 ID는 중복될 수 없다. 식별자·설명·파일 길이의 상한도 exporter와 맞춰 검사한다. 잘못된 `required` 타입을 생략해서 처리하거나 비밀값을 뜻하는 alias 이름을 수용하지 않는다. 이 검사는 새 목적지를 예약하기 전에 끝난다.

`OWNER_FROZEN`은 원래 exporter의 owner assertion 선언이며 importer가 당시 잠금의 정당성을 새로 인증하는 것은 아니다. `PINNED_BYTE_SET`도 원자적인 전체 파일시스템 snapshot을 뜻하지 않는다. 둘 다 복원 시에는 실제 전달받은 bytes를 검사한다.

## 새 목적지와 반복 실행

```text
<destinationParent>/<destinationName>/
  .staging/                 # 복사 중에만 존재
  workspace/                # 검증 후 같은 파일시스템에서 게시
  import-receipt.json       # 마지막에 게시하는 완료 표시
```

목적지 이름은 새 디렉터리 예약으로 배타적으로 확보한다. 기존 환경의 파일을 자동 합치거나 덮어쓰지 않는다. 복사·검증·게시 중 실패하면 완료 표시가 없는 예약이 남을 수 있으며, 이것을 완료된 복원으로 취급하지 않는다. 재시도는 그 예약을 자동 삭제하거나 사용 중인 다른 importer의 작업을 인계받지 않는다. 새 목적지 이름으로 재시도하거나 owner가 미완료 상태를 직접 확인해야 한다.

같은 완료 목적지에 다시 import하면 bundle digest·복원 모드·로컬 분기 ID와 실제 복원 bytes를 다시 확인한다. 모두 맞으면 `reusedExisting: true`다. 다른 bundle, 손상된 결과, 경합 중인 예약은 거부한다. 협력적인 두 importer가 같은 목적지를 동시에 요청하면 하나가 예약을 획득하며, 나머지는 완료 결과를 재검증하거나 진행 중 상태로 거부된다.

원래 파일의 실행 비트·소유권·ACL·시각·하드링크 관계는 이 파일 profile에 포함되지 않는다. 디렉터리와 완료 표시를 단계적으로 게시하지만 디스크·전원 장애 후 영속성 전체를 인증하지 않는다.

## 과거 상태와 최신 상태

기본 `freshnessMode`는 `HISTORICAL_SNAPSHOT`이다. 이 모드의 성공은 과거 자료를 복원했다는 뜻이며 최신 owner 상태를 활성화했다는 뜻은 아니다.

owner가 별도로 아는 기준을 `ownerState.resources`의 `{nativeId, headRevisionId?, withdrawn?}`로 전달할 수 있다. 이 기준은 허용한 owner namespace에 한정되며 중복 키는 받지 않는다.

| 결과 | 뜻 |
|---|---|
| `FRESHNESS_UNKNOWN` | 해당 자원의 현재 기준을 받지 못함 |
| `MATCHES_KNOWN_HEAD` | 전달한 owner 기준 revision과 일치함. 실시간 조회·전역 최신성 증명은 아님 |
| `DIVERGED` | 전달한 현재 head와 다른 과거 revision |
| `WITHDRAWN` | owner 기준에 철회·삭제로 표시됨 |

자원별 결과를 보존하며, 한 자원의 일치로 전체 복원을 최신 상태라고 판정하지 않는다. 파일이 없다는 사실을 삭제로 추론하지 않는다. 철회되었거나 분기한 과거 자료도 명시적인 역사 조회로 복원할 수 있지만, 이를 자동으로 현재 head에 반영하지 않는다.

`LOCAL_BRANCH`는 별도로 지정한 `localBranchId`의 새 로컬 작업 사본을 만든다. 원래 revision ID를 바꾸거나 전역 최신성을 선언하지 않는다. 이 모드는 Git branch 생성 기능과 구별되며, 후속 수정의 revision 병합은 PT06 범위다.

`registry`에는 owner가 별도로 아는 resource tuple, revision ID, representation ID와 각각의 `descriptorDigest`를 전달할 수 있다. digest는 정확한 PT01 descriptor의 `contractDigest`다. 같은 ID의 정의가 다르면 거부한다. 임포터가 새 ID를 만들거나 긴 native ID를 잘라 충돌을 피하지 않는다. manifest의 native ID 상한은 256자다.

## 기존 바인딩·그래프에 연결

`rebindPortableRestore(result, request)`는 importer가 같은 프로세스에서 발급한 검증 결과만 받는다. JSON으로 저장했다가 읽은 결과는 검증 핸들이 아니다. 함수는 원래 백업 위치가 없어도 복원된 파일과 완료 표시를 다시 검사한다.

`request`에는 기존 `bindings`, 새 로컬 `workspaceId`, 그리고 다음 명시적 선택 목록을 전달한다.

```text
resource                기존 USL resource ID
bindingRepresentation   기존 바인딩의 로컬 표현 ID
nativeId                복원할 원본 owner ID
revisionId              복원한 revision ID
representationId        PT01 representation IRI
```

바인딩의 표현 이름과 PT01 representation IRI는 서로 다른 계약이므로 문자열을 잘라 자동 변환하지 않는다. owner가 명시적으로 대응을 선택한다. 기존 바인딩의 digest가 복원 bytes와 충돌하면 거부한다. 역사 snapshot은 `relation: "snapshot"`, 로컬 작업 분기는 `relation: "working-copy"`를 명시해야 한다. 새 workspace ID가 선택하지 않은 표현까지 다른 위치로 옮기게 되는 경우도 거부한다.

선택적으로 기존 resource graph JSON을 `graph`에 전달하면 해당 자원의 locator만 갱신한다. resource ID·type·metadata, 의미, 링크 ID, 역할·순서, provenance는 유지한다. 반환하는 workspace 경로와 바인딩은 **`LOCAL_PROPOSAL_ONLY`**다. 호스트 등록·접근 권한·실행 권한을 자동 설치하지 않는다.

복원된 작업 기록은 `HISTORICAL_UNRECONCILED`이며 importer의 외부 실행 호출은 0회다. 예전 reservation이나 receipt를 분산 exactly-once 근거로 사용하거나 불명확한 효과를 재시도하지 않는다. 원래 owner의 현재 효과 대조는 후속 PT07이다.

## CLI와 인수검사

CLI spec은 SDK 입력 중 목적지 두 필드를 제외한 JSON이다. 목적지는 명령행에서 별도로 지정한다. spec으로 실행 프로그램·callback·권한을 등록할 수 없다.

```sh
npm run portable-transfer:import -- --help
npm run portable-transfer:import -- --spec /path/to/import-spec.json --destination-parent /path/to/restores --destination-name notes-history
```

입력·메타데이터 크기, 파일 수, bytes와 협력적 시간 예산을 제한하며 경로 이탈·심볼릭 링크·특수 파일을 거부한다. owner가 통제하는 로컬 디렉터리에서 사용하며 같은 권한의 적대적인 프로세스나 커널 I/O의 강제 취소를 보장하지 않는다.

[복원 테스트](../test/portable-transfer-restore.test.ts), [재바인딩 테스트](../test/portable-transfer-bindings.test.ts), [이동 인수검사](../test/portable-transfer-portability.test.ts)는 서로 다른 목적지·원본 부재·손상·추가 파일·중복 import·경합·오래된 상태를 검사한다. [OS 간 전달 workflow](../.github/workflows/portable-transfer.yml)는 Linux producer의 묶음을 Linux/macOS/Windows consumer에 전달하도록 구성한다. workflow 작성은 그 플랫폼에서의 성공 증거가 아니며, 실제 실행한 OS와 미실행 OS는 [진행 기록](DEVELOPMENT_PROGRESS.md)에 따로 남긴다.

[별도 측정 도구](../scripts/measure-portable-transfer.ts)는 새 프로세스에서 실제 import bytes·경과 시간·후속 해시 검사 시간·peak RSS를 출력한다. 이 수치는 해당 fixture·프로세스의 관측이며 다른 플랫폼의 성능이나 운영 효과에 대한 보증은 아니다.
