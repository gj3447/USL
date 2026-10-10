# 메모리 이동 이벤트와 조건부 바인딩 갱신

`usl/memory-relocation`은 이미 새 위치에 복사된 regular 파일의 내용을 확인하고,
소유자가 관리하는 상태 저장소에서 선택한 USL 바인딩을 조건부로 갱신한다.
같은 기억의 같은 revision을 다른 위치에서 읽는 경우에 사용한다. 파일 복사와
발견은 저장소가 담당하고, USL은 기존 resource ID·의미·역할·출처를 유지한다.

이 흐름은 메타휴모토닉·OMC의 메모리 이동에 사용할 연결 경계다. 현재 구현은
로컬 파일과 호출자가 제공하는 상태 콜백까지이며, 실제 OMC·P2P·KG 저장소에
접속하거나 공유·배포하지 않는다. 라이선스 수락은 메모리 접근 권한이 아니다.

## 서로 다른 세 입력

| 입력 | 내용과 책임 |
|---|---|
| 소유자 상태 | owner namespace, resource/representation/revision ID, 원래 bytes의 SHA-256·길이, generation, ACTIVE/WITHDRAWN, bindings, graph |
| 이동 이벤트 | 위 정체성, 기대하는 이전 상태 digest, 새 workspace alias·상대 경로 |
| 호스트 | 허용한 workspace roots, 읽기 한도, 현재 상태 읽기와 원자적 compare-and-swap(CAS) |

이벤트에 절대 root, 실행 명령, 새 내용 hash를 넣지 않는다. 내용 비교의 기준은
소유자가 독립적으로 보관한 현재 cursor의 pin이며, 선택한 기존 binding도 같은
digest를 가져야 한다. 내용이 바뀐 기억은 새 revision으로 다뤄야 하므로 이 API는
그 갱신을 거부한다. revision 이름만으로 내용의 진위를 인증하지는 않는다.

## 실행 순서

1. 이벤트와 호스트 설정을 복사·검사한다. 현재 소유자 상태를 읽고 상태 전체의
   digest, 정체성, revision, 철회 상태를 대조한다.
2. 등록된 alias 아래 목적지의 상대 경로를 해석한다. 경로 이탈, symlink,
   일반 파일이 아닌 대상과 한도 초과를 거부한다. 원본 위치는 읽지 않는다.
3. 실제 파일 bytes를 읽어 현재 pin과 비교한다. 열린 파일의 inode·크기·수정
   시각 등도 전후 대조한다. 선택한 binding의 alias/path와 graph locator만 바꾼다.
4. 목적지 bytes·경로를 다시 검사한다. 기존 ID·타입·metadata·의미·링크·역할·
   provenance는 그대로 두고 cursor generation을 1 증가시킨다.
5. `compareAndSwap(previousStateDigest, nextState)`로 상태 전체를 조건부 갱신한다.
   검증 중 다른 이동·철회·수정이 생겼다면 호스트는 `false`를 반환해야 한다.

같은 이벤트를 다시 보내면 이전 상태 digest가 달라 `STALE`로 거부한다.
event ID 자체를 유일성이나 전역 실행 보장으로 사용하지 않는다. 소유자 상태의
generation을 과거로 되돌리지 않아야 하며, 재시작 이후 보장은 그 상태와 CAS를
영속적으로 보존하는 호스트에 달려 있다. USL은 별도 DB를 만들지 않는다.

이벤트와 receipt는 alias·상대 경로를 쓰지만, 반환 graph의 선택 locator는 로컬
절대 위치를 포함한다. 이 상태는 소유자의 비공개 로컬 저장소에 보관하며 자동
게시하지 않는다. 공유용 표현은 별도로 선택해야 한다.

파일 관측과 상태 저장소의 갱신은 하나의 파일시스템 트랜잭션이 아니다. 검증이
끝난 직후 파일이 다시 바뀔 수 있으므로 실제 읽기·실행 시 pin을 다시 확인해야
한다. 같은 OS 계정의 적대적인 경로 교체, 전원 장애, 전역 최신성, 원자적 파일
이동을 보장하지 않는다. 원본 삭제 여부는 `sourceStatus: NOT_OBSERVED`다.

## SDK 연결

```ts
import {
  memoryBindingStateDigest, relocateMemoryBinding,
  type MemoryRelocationHost,
} from "usl/memory-relocation"

// ownerStore와 localRoots는 호출자가 이미 소유·등록한 것들이다.
const current = await ownerStore.readState()
const host: MemoryRelocationHost = {
  readState: () => ownerStore.readState(),
  compareAndSwap: (expected, next) => ownerStore.compareAndSwap(expected, next),
  workspaces: localRoots,
  maxBytes: 1024 * 1024,
}
const result = await relocateMemoryBinding({
  schema: "usl-memory-relocation/v1",
  id: "urn:example:move:2",
  ownerNamespace: current.cursor.ownerNamespace,
  resource: current.cursor.resource,
  representation: current.cursor.representation,
  revisionId: current.cursor.revisionId,
  expectedStateDigest: memoryBindingStateDigest(current),
  destination: { workspace: "memory-on-device-b", path: "notes/memory.md" },
}, host)
// result.state는 갱신된 owner 상태, result.receipt는 이 CAS 결과의 기록이다.
```

초기 상태의 schema는 `usl-memory-binding-state/v1`이며 `cursor`, `bindings`,
`graph`를 가진다. `graph`는 기존 `resource-graph/v1` JSON 문자열이다.
`parseMemoryBindingState`로 검사할 수 있다. cursor의 필드는 첫 표와 API 타입에
명시돼 있다. 이동 대상으로 선택한 representation은 `kind: workspace`여야 한다.

CAS는 **cursor·bindings·graph 전부를 같은 원자적 갱신에 포함**해야 한다.
`false`는 이번 요청이 아무 상태도 저장하지 않았다는 뜻이다. `true`는 이 조건부
갱신이 완료됐다는 호스트의 응답이다. USL이 임의 저장소의 원자성을 인증하지는
않는다. readState/CAS 콜백의 구현과 현재 접근 권한은 호스트 책임이다.

소유자 CAS가 예외를 던지거나 boolean 이외의 결과를 주면 `COMMIT_UNKNOWN`이다.
이 경우 성공 여부를 추측해 재시도하지 않는다. 현재 저장소를 다시 읽어 결과
상태를 대조해야 한다. 성공 receipt는 현재 head의 영구 보장이 아닌 갱신 기록이다.

## 거부와 범위

| 오류 코드 | 뜻 |
|---|---|
| INVALID_INPUT | 계약·기존 pin 불일치, 잘못된 경로, 읽기 예산 초과 선언, 같은 목적지 |
| STALE | 이전 상태 digest가 현재 상태와 다름 |
| WITHDRAWN | 현재 소유자 상태가 철회됨 |
| IDENTITY_MISMATCH | owner·자원·표현·revision을 바꾸는 이벤트 |
| CONTENT_MISMATCH | 목적지 bytes 또는 길이가 현재 pin과 다름 |
| UNAVAILABLE | 상태/목적지 없음, 등록되지 않은 alias, symlink, 비정규 파일, 읽기 한도 초과 |
| CONFLICT | 검증 중 경로 변경, 미선택 표현의 동일 alias/path, CAS 충돌 |
| COMMIT_UNKNOWN | 상태 저장소의 갱신 결과가 불명확함 |

하나의 호출은 자원 하나의 선택 표현만 갱신한다. 기존 bindings 한도, graph
UTF-8 1 MiB 한도, 파일 기본 1 MiB/최대 16 MiB 한도를 적용한다. 여러 alias가
같은 실제 파일을 가리키는지 전수 탐색하거나 복제본 동일성을 추론하지 않는다.
root 자체 이동을 처리할 때는 새 workspace alias를 선택한다. 같은 alias의 root
변경은 별도의 호스트 설정 변경이며 이벤트가 그 설정을 덮어쓸 수 없다.

원문이 사라져도 이미 보존된 목적지 bytes가 pin과 맞으면 연결할 수 있다. 모든
사본이 사라진 기억의 복원, 자동 복제/탐색, 분할·요약·병합, 권한 확대와 외부
실행은 이 API에 포함되지 않는다. 백업 생성·복원에는 기존
[portable transfer](PORTABLE_TRANSFER_IMPORT.md)와 [Git 상태 복원](PORTABLE_TRANSFER_GIT_STATE.md)을 사용한다.

## 검증

[테스트](../test/memory-relocation.test.ts)는 실제 파일 A→B→C, 원본 부재,
같은 native ID로 context 조회, JSON-LD 자원·관계 ID 보존, 내용/정체성 불일치,
stale·철회·동시 CAS·불명확한 저장 결과를 다룬다. 테스트의 owner 저장소는
메모리 내 CAS fixture다. 외부 저장소의 durable CAS, 실기기 간 이동 인수는 별도다.

[읽기 전용 검사](../test/memory-relocation-readonly.test.ts)는 저장소에 이미 있는
파일을 대상으로 실제 해시 검증·재바인딩·USL 탐색과 CAS 오류 처리를 실행한다.
파일을 복사하거나 지우지 않으므로 이동 자체의 인수검사와 구분한다.

2026-10-10 로컬 실행: 읽기 전용 검사 6개와 RAM 파일시스템(tmpfs)의 이동 검사
7개가 통과했다. 디스크 scratch 실행기는 root reserve 부족으로 거부했고,
소규모 이동 fixture는 디스크를 쓰지 않는 RAM 공간에서 30초/파일별 1 MiB 한도로
실행 후 정리했다. 이 결과는 디스크 장애·OS 간 전달·P2P 운영 인수 증거가 아니다.

```sh
node --import tsx --test test/memory-relocation.test.ts
TSX_DISABLE_CACHE=1 node --import tsx --test test/memory-relocation-readonly.test.ts
npm run typecheck
```
