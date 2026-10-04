# PT02 · 고정 파일 집합 내보내기

선택형 `usl/portable-transfer-export`는 owner가 선택하고 해시·크기를 미리 고정한 파일들을 새 백업 묶음으로 복사한다. 원래 owner namespace, native ID, revision ID, representation ID와 상대 복원 경로를 보존한다. 파일 복사와 메타데이터 검증이 끝난 묶음에만 완료 receipt를 게시한다.

[PT01 이동 계약](PORTABLE_TRANSFER.md)을 사용하며, 이 단계의 지원 범위는 **명시적인 파일 집합의 로컬 export**다. `PINNED_FILES` 묶음의 검사·새 root 복원·선택한 바인딩/그래프 재연결은 [PT03 import·rebinding 안내](PORTABLE_TRANSFER_IMPORT.md)에 있다. [개발 진행과 실행 근거](DEVELOPMENT_PROGRESS.md)는 최초 계획과 별도로 관리한다.

## 일관성 조건

| snapshot profile | 필요한 입력 | 확인하는 범위 |
|---|---|---|
| `OWNER_FROZEN` | owner가 만든 고정 snapshot의 ID, 파일별 독립적인 SHA-256·길이, `owner.assertConsistent` callback | 복사 전후 owner assertion과 실제 복사 bytes를 확인한다. owner의 잠금·DB snapshot 구현 자체를 인증하지 않는다. |
| `PINNED_BYTE_SET` | 미리 선택한 유한 파일 목록, 파일별 독립적인 SHA-256·길이, `expectedClosureDigest` | 복사한 모든 파일이 미리 고정한 논리적 파일 집합과 같은지 확인한다. 파일시스템 전체의 원자적 snapshot을 주장하지 않는다. |

CLI는 `PINNED_BYTE_SET`만 받는다. 실행 시 읽은 파일로 기대 해시를 새로 계산한 뒤 이를 독립적인 snapshot 증거라고 부르면 안 된다. 운영 DB는 해당 DB owner의 일관된 export·snapshot 기능으로 먼저 산출해야 한다. 이 모듈은 live DB 파일을 자동 발견하거나 잠그지 않는다.

현재는 자원별 하나의 CONTENT revision을 담으며 `parents`는 생략하거나 빈 배열이어야 한다. 기존 PT01의 DAG·tombstone 표현은 유지하지만 이 exporter가 전체 이력을 자동 수집하지는 않는다. ID를 자르거나 같은 내용 해시의 자원을 합치지 않는다.

## SDK와 CLI

SDK의 `exportPortableTransfer(request)`는 다음 입력을 받는다.

| 입력 | 내용 |
|---|---|
| `schema` | `usl-portable-transfer-export/v1` |
| `sourceRoot`, `destinationParent` | 서로 포함하지 않는 로컬 디렉터리. 번들 메타데이터에 자동 저장하지 않는다. |
| `ownerNamespace`, `issuer`, `observedAt` | PT01 owner IRI·발행자 IRI·UTC 관측 시각 선언 |
| `owner` | `snapshotId`와 SDK에서만 사용할 수 있는 `assertConsistent` callback |
| `snapshotProfile`, `restoreProfile` | 일관성 조건과 복원 범위 선택 |
| `files` | `sourcePath`, `payloadPath`, 원본 ID 세 종류, `expectedByteDigest`, `expectedByteLength` |
| `dependencies` | 의존성 ID, 분류, 필수 여부, 이유, PACKAGED일 때 `packagedRepresentationIds` |
| `expectedClosureDigest` | `portableTransferClosureDigest(restoreProfile, files, dependencies)`로 미리 고정한 선택 범위의 digest |
| `aliasDictionary` | 선택적 공개 alias → 번들 내 상대 payload 경로 매핑 |
| `maxTotalBytes`, `maxDurationMs` | 기본 상한을 낮추는 선택적 예산 |

`portableTransferClosureDigest`는 파일의 ID·복원 경로·payload 경로·기대 해시·길이와 정규화된 의존성 목록을 고정한다. owner가 빠뜨린 의존성을 자동 발견하는 함수는 아니다.

CLI JSON spec에는 SDK의 `owner` 대신 `snapshotId`를 두고, `snapshotProfile: "PINNED_BYTE_SET"`, `expectedClosureDigest`, `dependencies` 배열을 명시한다. `sourceRoot`는 절대경로이며 destination은 별도 CLI 인자다. 함수·실행 프로그램·owner 권한을 spec에서 등록할 수 없다.

```sh
npm run portable-transfer:export -- --help
npm run portable-transfer:export -- --spec /path/to/local-export-spec.json --destination-parent /path/to/backups
```

결과 JSON에는 `bundlePath`, `snapshotId`, `manifestDigest`, `receiptDigest`, `selfContained`, 파일 수와 복사 bytes가 들어간다. `bundlePath`는 현 기기에서의 결과 위치다. **`receiptDigest`는 번들과 별도로 신뢰할 수 있는 owner 기록에 보관**해야 한다. 번들 자체에서 읽은 receipt와 digest만으로 출처를 인증할 수는 없다. `manifestDigest`만으로는 정책·복원 경로·dictionary가 고정되지 않는다.

## 복원 범위와 의존성

`PINNED_FILES`는 선택한 파일들과 명시적으로 선언한 필수 의존성만 다룬다. `PACKAGED`는 실제 복사·검증한 representation ID들을 가리켜야 한다. 호출자가 `verified: true`를 넣어 완료 상태를 만들 수 없다. `EXTERNAL_REQUIRED`가 남으면 `selfContained`는 false다. `OPTIONAL`은 선택 범위의 복원에 필수가 아닌 의존성이다.

`GIT_WORKTREE`를 선택하면 Git 객체·ref·공통 관리 정보, worktree별 HEAD·index·설정, dirty/untracked, submodule, LFS, alternates를 외부 필수 의존성으로 기록한다. 이 exporter는 해당 Git 복구 정보를 자동 묶지 않으므로 **`selfContained: false`**다. Git closure의 재구성/repair도 아직 지원하지 않는다. linked worktree 폴더만 복사한 결과를 독립적인 Git 백업으로 판정하지 않는다. Git 호스트 설정·자격증명도 자동 수집하지 않는다.

파일 profile의 `selfContained: true`는 선언한 파일 집합을 충족했다는 뜻이다. 임의의 프로그램·DB·Git 저장소 전체를 복구할 수 있다는 뜻은 아니다. 실행 비트·소유권·ACL·원래 시각·하드링크 관계는 보존하지 않는다. 선언한 의존성 이름과 실제 애플리케이션 의미의 대응은 owner 책임이다.

## 번들과 게시 절차

```text
usl-transfer-<새 UUID>/
  receipt.json
  payload-bundle/
    manifest.json
    envelope.json
    inventory.json
    policy.json
    dictionary.json
    schema.json
    payload/<명시한 ASCII 상대 경로>
```

`manifest.json`은 PT01 계약, `envelope.json`은 본문 밖의 manifest digest다. `inventory.json`은 파일별 ID·해시·길이·상대 복원 경로와 의존성 목록을 담는다. 한글 원본 이름은 `restorePath`에 보존하고 payload에는 ASCII 이름을 사용할 수 있다. `schema.json`에는 manifest·envelope의 JSON Schema와 지원 profile을 넣는다. schema만으로 ID 참조·경로 충돌·digest의 의미 검증까지 대신하지는 않는다.

`receipt.json`은 여섯 메타데이터 파일 각각의 실제 SHA-256·길이를 고정한다. 새 디렉터리를 배타적으로 예약하고 내부 staging에서 복사·검증한 뒤 receipt를 마지막에 게시한다. 예외 발생 시 자신이 만든 미완료 묶음을 정리한다. 프로세스 강제 종료나 전원 장애로 receipt 없는 디렉터리가 남을 수 있으며, 이는 완료된 백업이 아니다. 디스크의 영속성이나 전원 장애 후 원자적 보존은 별도 보장하지 않는다.

## 입력 경계와 검증 범위

파일 수는 최대 1,024개, 총 payload는 최대 512 MiB, 기본 협력적 시간 예산은 5분이다. CLI spec은 최대 2 MiB다. 파일 복사는 스트리밍으로 처리하고 부분 write를 이어 쓰며 복사된 bytes도 다시 확인한다. 경로 이탈·심볼릭 링크·FIFO 등 비정규 파일, 중복 ID, 대소문자·Unicode 정규화에 따른 복원 경로 충돌을 거부한다. 알 수 없는 입력 필드와 accessor를 통한 가변 입력도 받지 않는다.

호스트별 등록·비밀 파일의 일부 알려진 위치는 거부하며, 원본 root나 실행 callback은 내보내지 않는다. 명시적으로 선택한 임의의 payload 내용에 비밀이 없는지 판별하는 기능은 아니다. exporter는 owner가 통제하는 디렉터리에서 실행해야 한다. 파일시스템 전체를 잠그지 않으며, 같은 권한의 다른 프로세스가 디렉터리를 적대적으로 바꾸는 상황이나 중단 불가능한 owner callback·커널 I/O의 강제 취소를 보장하지 않는다.

[테스트](../test/portable-transfer-export.test.ts)는 실제 임시 파일과 별도 CLI 프로세스로 C1–C4를 검사한다. [진행 receipt](../research/development-progress/receipt.json), [TAP 원문](../research/development-progress/tests.tap), [RDF/JSON-LD](../research/development-progress/trace.jsonld)가 실행한 검사를 계획 조건에 연결한다. 이 기록은 현재 Linux 로컬 범위의 증거이며, 모든 OS나 실제 다른 컴퓨터에서의 복원 완료 증거는 아니다.
