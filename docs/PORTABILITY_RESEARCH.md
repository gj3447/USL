# USL 기기 이동과 백업 복원의 구현 근거

USL이 컴퓨터·메모리 저장소·작업경로 이동을 견디려면 고정 ID에 더해 일관된 snapshot, 닫힌 복원 범위, 검증 후 활성화, 인과 이력과 명시적인 owner 계약이 필요하다. 조사 결과를 현재 코드와 대조해 다음 구현의 선택과 반례를 정리했다.

조사 기준일은 2026-10-03, 코드 기준은 `7ab9afaa4e99ca77f7c2d26045de5a1cfae8f670`이다. 외부 1차 자료 27개를 조사했으며 원문이 정하는 사실과 USL에 대한 AI 구현 제안을 구분한다. 현재 PT01은 순수 manifest 계약까지 구현되어 있다. 이번 작업은 조사 그래프와 제한된 코드 관측이며 export/import 런타임을 추가한 것은 아니다.

## 구현 판단

ID를 보존한 이동·검증 가능한 백업 복원·오프라인 작업 분기는 구현 가능하다. 모든 사본 소실 뒤 복구, 통신이 끊긴 다른 기기의 전역 최신성, 임의의 외부 시스템에 대한 exactly-once는 조건 없이 보장할 수 없다. 누락·충돌·미확정 상태를 유지하고 명확한 범위에서만 성공으로 판단하는 것이 설계 기준이다.

현재 구조에서 계속 사용할 것은 owner/native ID, revision parent DAG, tombstone, 명시적 digest 알고리즘, host가 제공하는 pin이다. 다음에는 schema를 크게 늘리기보다 PT02 export inventory와 PT03 restore 상태 전이를 먼저 완성하는 것을 제안한다.

| 순서 | 제안 | 이유 |
|---|---|---|
| 1 | PT01 호환성·경로 capability gap을 명시하고 export inventory 설계를 먼저 고정 | 기존 ID·파일 이름을 잃지 않는 계약을 먼저 고정 |
| 2 | PT02 고정 파일 집합 export의 로컬 실행 근거를 유지하고 PT03 새 목적지 검증·복원을 구현 | 읽을 수 있는 파일과 일관된 snapshot은 다름 |
| 3 | PT03 같은 filesystem staging·검증·no-replace publication·로컬 binding | 복원 도중 기존 환경 손상과 부분 활성화를 차단 |
| 4 | PT04 Linux/macOS/Windows와 장애 주입 인수검사 | 문서·parser 검사를 실제 복원 성공과 구별 |
| 5 | PT05 메모리 조각, PT06 인과 충돌, PT07 owner 조건부 효과 대조 순으로 확장 | 일반 파일 복원 위에 도메인 기능을 추가 |

## 현재 코드에서 확인한 경계

순수 runtime probe 네 개를 실제 실행했다. OS 파일 생성이나 다기기 복원 실험은 아니다. 기존 PT01의 12개 통과 기록은 이전 영수증을 읽은 것으로, 이번에 그 테스트를 재실행했다고 기록하지 않는다.

- 300자 ASCII 파일명 성분은 manifest가 허용한다. 목표 filesystem의 성분 길이·전체 경로 길이는 별도 검사해야 한다.
- 300자 native ID는 기존 resource bindings가 허용하지만 portable v1은 거부한다. 기존 ID를 줄이거나 새 ID로 바꾸는 자동 migration은 부적절하다.
- 같은 revision ID에 서로 다른 digest를 넣은 두 manifest는 각각 parse된다. 문서 간 충돌 대조는 importer가 추가해야 한다.
- 미래 관측 시각을 넣어도 host 검사 결과는 freshness UNKNOWN, payload NOT_CHECKED, authority NOT_GRANTED를 유지한다.

이 중 앞의 세 항목은 지원 범위와 후속 구현 공백이다. 마지막 항목은 이미 지켜지는 상태 분리다. [Probe 코드](../scripts/probe-portability-research.ts)와 [관측 데이터](../research/portability-research/research.json)에 기준을 남겼다.

## 제안한 export와 restore 절차

```mermaid
flowchart LR
  A[owner 범위와 지원 확인] --> B[snapshot 또는 쓰기 중지]
  B --> C[범위 목록과 bytes 수집]
  C --> D[해시 크기 의존성 검증]
  D --> E[완료된 bundle 봉인]
  E --> F[목적지 filesystem staging]
  F --> G[검증과 충돌 대조]
  G --> H[sync와 no-replace 공개]
  H --> I[새 로컬 binding 연결]
```

각 전이는 자원 수·bytes·시간 예산을 갖고 실패 상태를 기록한다. Bundle의 완전성, bytes 무결성, snapshot 일관성, 저장 내구성, 현재성, 권한은 별도 값이다. 일반 파일의 순차 복사와 stat 비교만으로 다중 파일의 원자적 snapshot을 주장하지 않는다. Owner snapshot을 얻을 수 없으면 제한된 capture로 표시한다.

SQLite는 owner backup API를, Git은 refs 외에 working tree·submodule·LFS 목록을 사용한다. 원래 파일명은 번들 내부 ASCII 경로와 별도로 기록한다. 복원은 검증된 새 목적지에서 시작하고 환경 recipe 설치나 외부 실행은 별도의 명시적 작업이다.

## 근거에 따른 설계 결정

다음은 모두 SECONDARY_AI의 PROPOSED 판단이다. 인용은 판단의 근거이며 해당 표준이 USL의 구현 방식 전체를 의무화하거나 현재 기능을 인증한다는 뜻이 아니다. P0는 안전한 MVP 전에 결정할 사항, P1은 그 위에 추가할 기능이다.

### PR01 기존 정체성과 번들 사이 충돌을 보존한다

**P0 · PT01, PT03**. 기존 owner/native ID를 보존한다. 새 revision·bundle에는 충돌 검사 가능한 전역 ID를 발급하고 경로·내용 해시로 기존 자원 ID를 바꾸지 않는다. 같은 revision ID의 다른 정의를 만나면 HOLD하고 명시적 fork만 새 자원이 된다.

현재: PT01에 owner/native ID 분리·문서 내부 중복·parent DAG·tombstone·digest pin 검사가 구현되어 있다. 문서 간 충돌 대조와 긴 ID 호환성은 후속이다.

남은 범위: v1의 native ID 256자 제한과 기존 bindings 4096자 범위를 비교해 지원 범위를 명시하거나 별도 버전으로 확장해야 한다. 자동 절단·정규화는 금지한다.

근거: [RFC 9562 UUID](https://www.rfc-editor.org/rfc/rfc9562.html), [Oxford Common File Layout 1.1](https://ocfl.io/1.1/spec/).

- **PR01-1 · NOT_RUN:** 이동·복원·재수입은 ID 보존, 명시한 fork만 새 ID와 derivedFrom을 갖는다. 반례: 같은 bytes의 별개 owner 자원 병합 또는 긴 기존 ID 자동 절단이면 실패.
- **PR01-2 · NOT_RUN:** 동일 revision ID+동일 정의는 멱등 수입, 다른 정의는 충돌로 남긴다. 반례: 두 번들의 같은 ID와 다른 payload를 최신 시각으로 자동 선택하면 실패.

### PR02 일관성 수준을 명시한 owner snapshot을 만든다

**P0 · PT02**. Owner snapshot 또는 쓰기를 멈춘 범위에서 capture한다. 일반 파일을 순차 복사한 결과는 혼합 시점일 수 있으므로 BEST_EFFORT_CAPTURE와 CONSISTENT_SNAPSHOT을 구별한다. SQLite는 Backup API 등 owner 수단을 사용하고 재시도·시간 예산을 둔다.

현재: 2026-10-04 로컬 구현: PT02 exporter는 OWNER_FROZEN owner assertion과 PINNED_BYTE_SET을 구분하고 독립적인 파일 해시·길이·closure pin을 검사한다. 23개 exporter 테스트 실행은 별도 개발 진행 receipt에 기록한다. DB snapshot API 및 다중 시스템 원자성은 구현·검증하지 않았다.

남은 범위: 여러 DB와 파일의 공통 시점은 별도 owner 조정이 필요하다. stat 전후 비교만으로 전체 작업환경의 snapshot을 증명하지 않는다.

근거: [SQLite Online Backup API](https://www.sqlite.org/backup.html), [SQLite Write Ahead Logging](https://www.sqlite.org/wal.html), [RFC 8493 BagIt](https://www.rfc-editor.org/rfc/rfc8493.html).

- **PR02-1 · NOT_RUN:** DB 동시 쓰기 fixture에서 owner snapshot 완료 여부·시점 범위와 오류를 기록한다. 반례: main DB만 복사하거나 여러 DB의 각각 다른 시점을 원자적 snapshot이라고 선언하면 실패.
- **PR02-2 · NOT_RUN:** Export 제한 시간·bytes·파일 수 초과와 원본 변경을 명시적으로 종료한다. 반례: 변경 중인 일반 파일의 부분 복사를 일관된 백업으로 seal하면 실패.

### PR03 복원 범위와 payload 목록을 닫는다

**P0 · PT02, PT03**. 별도 버전의 export inventory에 INCLUDED·REQUIRED_EXTERNAL·EXCLUDED와 이유, 원래 이름→ASCII payload 위치, hash·size·owner snapshot 참조를 기록한다. 선택한 복원 프로필에 필요한 항목이 모두 포함되어야 SELF_CONTAINED로 표시한다.

현재: 2026-10-04 로컬 구현: PT02가 실제 복사 bytes·원본 상대 복원 경로·ASCII payload 매핑·메타데이터 digest를 검사한다. PACKAGED는 실제 representation을 참조해야 하며 EXTERNAL_REQUIRED가 남으면 selfContained는 false다. 순수 PT01 manifest 의미는 유지한다.

남은 범위: 선택한 PINNED_FILES 범위 밖의 숨은 의존성과 전체 역사 보존은 증명하지 않는다. import의 namespace/native ID 충돌·무결성·복원 검사는 PT03이며 다기기 인수검사는 PT04다.

근거: [RFC 8493 BagIt](https://www.rfc-editor.org/rfc/rfc8493.html), [Oxford Common File Layout 1.1](https://ocfl.io/1.1/spec/).

- **PR03-1 · NOT_RUN:** Manifest와 실제 payload inventory를 양방향 대조하고 모든 크기·해시를 확인한다. 반례: 누락·추가 파일·알 수 없는 알고리즘·외부 의존성 미확보 상태를 SELF_CONTAINED로 처리하면 실패.
- **PR03-2 · NOT_RUN:** 한글 원래 이름과 ASCII 번들 경로의 일대일 매핑 및 directory 구조를 복원한다. 반례: 동일 내용이라는 이유로 별개 file entry나 원래 이름을 잃으면 실패.

### PR04 Git과 작업환경을 별도 복원 프로필로 기술한다

**P0 · PT02, PT04**. Git refs/objects, dirty patch·untracked, submodule, LFS bytes를 각각 inventory에 담는다. 환경 recipe에는 toolchain·lockfile·설치 옵션·OS/architecture 요구를 pin하고 기기별 root와 비밀정보는 로컬 참조로 남긴다.

현재: 기존 bindings의 local root 매핑에 더해 PT02 GIT_WORKTREE profile이 objects/refs/admin, worktree HEAD/index/config, dirty/untracked, submodule, LFS, alternates를 여섯 EXTERNAL_REQUIRED 항목으로 명시한다. Git closure나 환경 recipe의 실제 수집·재구성은 미구현이며 selfContained는 false다.

남은 범위: 환경 recipe의 저장은 설치·실행 승인이 아니다. 오프라인 복원에 필요한 dependency payload와 목표 플랫폼 지원을 별도 확인한다.

근거: [Git bundle](https://git-scm.com/docs/git-bundle), [Git submodule](https://git-scm.com/docs/git-submodule), [Git Large File Storage](https://git-lfs.com/), [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/), [Reproducible Builds definition](https://reproducible-builds.org/docs/definition/).

- **PR04-1 · NOT_RUN:** Dirty/untracked/submodule/LFS와 오프라인 dependency 누락 fixture별 export 상태를 정확히 기록한다. 반례: Git bundle만 존재하는데 전체 작업환경 복원이 가능하다고 선언하면 실패.
- **PR04-2 · NOT_RUN:** 다른 플랫폼에서 pin된 recipe의 지원 여부를 확인하고 불일치를 보고한다. 반례: node_modules나 절대경로 설정을 복사한 것만으로 실행 가능 상태로 승격하면 실패.

### PR05 검증과 내구성 확인 뒤 새 목적지를 공개한다

**P0 · PT03, PT04**. 새 목적지와 같은 filesystem의 private staging에 복원한다. 바이트·scope·경로를 검사하고 동기화한 뒤 no-replace publication을 수행한다. VISIBILITY_COMMITTED와 DURABILITY_CONFIRMED를 구분하며 binding을 마지막에 연결한다.

현재: PT01은 파일을 생성하거나 복원·활성화하지 않는다.

남은 범위: Node rename만으로 no-replace를 보장하지 않는다. 플랫폼 adapter 또는 배타적 destination 관리가 필요하며 cross-filesystem copy를 atomic publish라고 부르지 않는다.

근거: [Linux rename](https://man7.org/linux/man-pages/man2/rename.2.html), [Linux fsync](https://man7.org/linux/man-pages/man2/fsync.2.html), [Node.js 22 file system API](https://nodejs.org/docs/latest-v22.x/api/fs.html).

- **PR05-1 · NOT_RUN:** 복사·sync·publish·binding 단계마다 중단시켜 기존 환경이 유지되고 재시작 시 완성된 snapshot만 보이게 한다. 반례: 목적지 race로 기존 파일을 덮어쓰거나 sync 실패 뒤 durable 성공을 반환하면 실패.
- **PR05-2 · NOT_RUN:** 부분 실패와 재실행에서 동일 bundle을 중복 활성화하지 않고 staging 상태를 대조한다. 반례: 누락된 complete marker·손상 bytes·경로 탈출이 있는 staged bundle을 활성화하면 실패.

### PR06 경로 이름 검사와 목표 filesystem 검사를 나눈다

**P0 · PT02, PT03, PT04**. 번들 경로의 안전한 문자 규칙과 실제 목적지의 성분 길이·전체 길이·대소문자·Unicode·symlink/reparse point 정책을 별도로 검사한다. MVP는 regular file/directory만 지원하고 나머지는 명시적으로 거부한다.

현재: ASCII 상대 경로·예약명·대소문자·파일/폴더 prefix 충돌 검사는 있다. 실제 filesystem 한계 검사는 없다.

남은 범위: 현재 300자 ASCII 성분은 v1 parser가 허용한다. 이는 실제 filesystem 생성 성공의 증거가 아니며 native OS 인수검사가 필요하다.

근거: [Windows file naming rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file), [Windows maximum path length](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation), [Oxford Common File Layout 1.1](https://ocfl.io/1.1/spec/).

- **PR06-1 · NOT_RUN:** Linux/macOS/Windows 지원 프로필에서 긴 성분·case 충돌·한글 이름 매핑·symlink 탈출을 검사한다. 반례: 한 OS의 parser 검사만 통과하고 모든 OS에서 복원 가능하다고 선언하면 실패.

### PR07 기기별 작업 주체와 인과 분기를 추가한다

**P1 · PT06**. 복원 후 쓰기 가능한 clone에는 새 actor incarnation을 배정한다. actor/counter와 operation digest를 함께 비교하고 동일 ID의 다른 작업은 충돌로 보존한다. 부모 DAG에서 incomparable heads를 유지하며 시각으로 winner를 고르지 않는다.

현재: 현재 revision parent DAG와 cycle 거부는 있다. actor와 operation frontier 및 다기기 merge는 없다.

남은 범위: 현재는 revision parent DAG만 있다. actor·operation·frontier·conflict contract와 owner의 merge 정책이 추가로 필요하다.

근거: [Time Clocks and the Ordering of Events](https://lamport.org/pubs/time-clocks.pdf), [Automerge Binary Document Format](https://automerge.org/automerge-binary-format-spec/), [Automerge conflicts](https://automerge.org/docs/reference/documents/conflicts/).

- **PR07-1 · NOT_RUN:** 동일 backup에서 갈라진 두 기기가 시계가 달라도 충돌 작업과 두 heads를 보존한다. 반례: 복제된 actor counter로 서로 다른 작업을 같은 것으로 수입하거나 한 branch를 버리면 실패.

### PR08 삭제와 오래된 백업의 재등장을 구별한다

**P1 · PT03, PT06**. Tombstone과 인과 이력을 유지해 옛 live backup 도착이 삭제를 취소하지 못하게 한다. 삭제 기록 정리는 명시한 안정성·보존 정책과 복원 가능성 판단이 있을 때만 수행한다.

현재: 같은 자원의 부모를 갖는 tombstone과 live representation 금지는 있다. 분산 삭제 보존·정리는 없다.

남은 범위: 인과관계가 모자란 복원은 WITHDRAWN을 추정 확정하지 않고 CONFLICT 또는 UNKNOWN으로 남긴다. 단순 시간 만료만으로 tombstone을 지우지 않는다.

근거: [Syncthing Block Exchange Protocol v1](https://docs.syncthing.net/specs/bep-v1.html), [Time Clocks and the Ordering of Events](https://lamport.org/pubs/time-clocks.pdf).

- **PR08-1 · NOT_RUN:** 삭제 뒤 옛 live backup이 재등장해도 자동으로 현재 버전이 되지 않는다. 반례: 오프라인 peer의 미확인 상태에서 tombstone을 지워 삭제한 자료가 되살아나면 실패.

### PR09 최신성 대조와 외부 효과를 owner 계약으로 제한한다

**P1 · PT03, PT07**. 오프라인 역사 자료는 읽거나 새 로컬 분기로 쓸 수 있다. 전역 최신성은 owner의 현재 validator 조회 없이는 UNKNOWN이다. 외부 작업은 endpoint·request fingerprint·key 보존 기간·status 조회·조건부 버전·권한을 명시한 capability가 있어야 대조할 수 있다.

현재: 현재 host 검사 결과는 UNKNOWN/NOT_GRANTED이며 로컬 실행 recovery 계약도 있다. owner의 분산 효과 대조는 미구현이다.

남은 범위: Idempotency-Key 초안은 만료 상태이고 보편적 서버 지원을 가정할 수 없다. 응답 유실·만료·효과 불명이면 UNRECONCILED를 유지하며 자동 재실행하지 않는다.

근거: [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html), [Idempotency Key header draft 07](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.html).

- **PR09-1 · NOT_RUN:** 동일 key+fingerprint 재전송, 다른 payload 재사용, 만료와 응답 유실을 fake owner에서 분리한다. 반례: 과거 영수증만으로 현재 권한·효과 완료를 주장하거나 unknown 작업을 새 key로 재시도하면 실패.
- **PR09-2 · NOT_RUN:** 오프라인 역사 읽기와 로컬 branch는 가능하되 최신 상태·외부 쓰기 승인을 얻지 않는다. 반례: 현재성 미확인을 이유로 모든 역사 읽기를 막거나 반대로 CURRENT로 표시하면 실패.

### PR10 메모리 조각과 digest의 의미 범위를 고정한다

**P1 · PT05**. 자원 ID·revision digest에 원문 quote/context·position·State를 붙여 조각 이동 후보를 찾는다. 후보가 여러 개면 AMBIGUOUS다. raw bytes, 기존 USL contract digest, 선택적 JCS/RDFC digest는 알고리즘별로 별도 기록한다.

현재: 기존 USL contract digest가 있다. 이 프로젝트에서 JCS/RDFC 호환성과 메모리 조각 재탐색은 구현 완료로 주장하지 않는다.

남은 범위: 기존 digest를 JCS나 RDFC라는 이름으로 재해석하지 않는다. RDF 정규화는 실제 dataset 동형성에만 적용하며 blank-node 복잡도·시간 한계를 둔다.

근거: [Web Annotation Data Model](https://www.w3.org/TR/annotation-model/), [RDF Dataset Canonicalization 1.0](https://www.w3.org/TR/rdf-canon/), [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html).

- **PR10-1 · NOT_RUN:** 중복 quote는 선택을 요구하고 다른 revision의 같은 문장은 원래 앵커로 자동 채택하지 않는다. 반례: 위치나 텍스트 유사도만으로 원본과 동일하다고 재바인딩하면 실패.
- **PR10-2 · NOT_RUN:** 표준 fixture로 RDF 동형성 digest와 raw serialization digest를 구별한다. 반례: RDFC 일치가 의미·자원 정체성·권한 동일성을 증명한다고 처리하면 실패.

### PR11 표준 검증 결과와 정책 웨이트를 분리한다

**P0 · PT01, PT04, PT07**. SHACL 2017 구조 검증과 USL REQUIRED/BLOCK 정책을 분리해 기록한다. RECOMMENDED/PENALIZE 계수는 완전한 평가에만 적용하며 hard failure와 UNKNOWN을 상쇄하지 않는다. HSWM W 추정치를 쓸 때도 model·context·evidence·mapping version을 명시한 제안으로 연결한다. HSWM 연결 방식은 인용한 표준의 규정이 아니라 현재 로컬 evidence/review 코드에 근거한 AI 설계 제안이며 live 상태는 NOT_CONNECTED다.

현재: REQUIRED 차단과 RECOMMENDED 감점은 rule-policy에 구현되어 있고 evidence/review 제안 경계가 있다. Live HSWM은 NOT_CONNECTED다.

남은 범위: 로컬 정책 감점 계수가 HSWM W 자체가 되지는 않는다. SHACL 1.2는 조사 시점 Working Draft이며 실제 owner 연동은 수행하지 않았다.

근거: [SHACL 2017 Recommendation](https://www.w3.org/TR/2017/REC-shacl-20170720/), [SHACL 1.2 Core 2026 Working Draft](https://www.w3.org/TR/2026/WD-shacl12-core-20260918/), [W3C PROV O](https://www.w3.org/TR/prov-o/).

- **PR11-1 · NOT_RUN:** 필수 제약 실패와 UNKNOWN은 soft weight 변경으로 PASS가 되지 않으며 penalty와 authority가 분리된다. 반례: Warning을 숫자 W로 간주하거나 미평가 항목을 감점 0으로 처리하면 실패.

### PR12 출처와 상태를 포함한 반례 중심 인수검사를 한다

**P0 · PT04**. 요구사항→설계판단→근거→코드→인수기준을 추적하고 실행한 검사와 미실행 기준을 구분한다. Source status·revision·bytes pin·관측 시각을 보존하고 domain/range·cardinality·DAG 및 정확한 query endpoint를 검사한다.

현재: 기존 PT01 receipt는 당시 12개 로컬 계약 테스트의 통과를 기록한다. 이번 연구에서는 4개 순수 probe와 연구 그래프를 별도로 검증한다.

남은 범위: 이번 연구 그래프 검증은 export/import·다기기 내구성·외부 owner 연동의 실행 성공을 증명하지 않는다.

근거: [W3C PROV O](https://www.w3.org/TR/prov-o/), [SHACL 2017 Recommendation](https://www.w3.org/TR/2017/REC-shacl-20170720/), [RFC 8493 BagIt](https://www.rfc-editor.org/rfc/rfc8493.html).

- **PR12-1 · NOT_RUN:** OS별 crash·디스크 부족·부분 복사·오래된 backup·알 수 없는 schema를 실제 fault matrix로 검사한다. 반례: 노드 수만 맞추거나 문헌 조사만으로 인수기준을 PASS로 승격하면 실패.

## 표준의 상태와 적용 한계

SHACL의 안정된 검증 기준은 2017 Recommendation으로 유지한다. SHACL 1.2 Core의 2026-09-18 문서는 Working Draft다. Idempotency-Key draft 07은 Datatracker에서 만료·보관 상태이므로 확정 RFC로 채택하지 않는다. 아래 날짜는 자료 확인 시점이며 원문의 발행 시점 또는 실행 성공 시점이 아니다.

- [RFC 9562 UUID](https://www.rfc-editor.org/rfc/rfc9562.html) — `IETF_STANDARDS_TRACK`, 5.4; 6.7–6.9, 확인 2026-10-03. 사실 요약: UUID는 중앙 등록 없이 생성할 수 있지만 충돌 위험과 생성기 상태를 고려해야 한다. 한계: UUID나 시간 정렬은 소유권·접근 권한·분산 인과관계의 증명이 아니다.
- [RFC 8493 BagIt](https://www.rfc-editor.org/rfc/rfc8493.html) — `IETF_INFORMATIONAL`, 3 Complete and Valid Bags, 확인 2026-10-03. 사실 요약: Complete는 필요한 파일의 존재를, valid는 여기에 checksum 검증 성공을 요구한다. 한계: USL 정체성·일관된 DB snapshot·복원 활성화·권한은 정의하지 않는다.
- [Oxford Common File Layout 1.1](https://ocfl.io/1.1/spec/) — `COMMUNITY_SPECIFICATION`, 3.5 Inventory; manifest and versions, 확인 2026-10-03. 사실 요약: Inventory는 content digest와 파일 경로 및 버전 상태를 연결하고 경로 성분과 prefix 충돌을 제한한다. 한계: OCFL의 선형 버전 번호를 분산 기기의 인과 이력으로 그대로 사용하면 안 된다.
- [SQLite Online Backup API](https://www.sqlite.org/backup.html) — `OFFICIAL_DOCUMENTATION`, 1; 1.1; 3.1, 확인 2026-10-03. 사실 요약: 완료된 backup API는 일관된 DB snapshot을 만든다. 동시 쓰기로 재시작될 수 있으며 VACUUM INTO도 별도 파일 snapshot 수단이다. 한계: 여러 DB·파일의 공통 시점을 보장하지 않으며 동시 쓰기가 잦으면 완료 시간이 제한되지 않을 수 있다.
- [SQLite Write Ahead Logging](https://www.sqlite.org/wal.html) — `OFFICIAL_DOCUMENTATION`, 2 How WAL Works; WAL file, 확인 2026-10-03. 사실 요약: Commit된 변경이 checkpoint 전 WAL에 남을 수 있어 main DB 파일만으로 전체 상태를 나타내지 못한다. 한계: 임의 시점에 DB와 WAL을 따로 복사하는 절차의 일관성을 보증하지 않는다.
- [Git bundle](https://git-scm.com/docs/git-bundle) — `OFFICIAL_DOCUMENTATION`, Description; verify; prerequisites, 확인 2026-10-03. 사실 요약: Bundle은 선택한 refs와 Git objects를 전송하며 incremental bundle은 prerequisite objects를 요구한다. 한계: Git object 집합만으로 dirty·untracked 파일과 별도 저장소의 payload가 포함됐다고 할 수 없다.
- [Git submodule](https://git-scm.com/docs/git-submodule) — `OFFICIAL_DOCUMENTATION`, Description; update, 확인 2026-10-03. 사실 요약: Submodule은 superproject에 연결되는 별도 Git 저장소다. 한계: 상위 저장소의 bundle은 하위 저장소 object와 작업 상태의 보존 증명이 아니다.
- [Git Large File Storage](https://git-lfs.com/) — `OFFICIAL_PROJECT_DOCUMENTATION`, Overview, 확인 2026-10-03. 사실 요약: Git LFS는 Git에 pointer를 두고 큰 파일 내용은 별도 서버에 보관한다. 한계: Pointer가 있다는 사실은 복원할 payload bytes가 번들 안에 있다는 뜻이 아니다.
- [Linux rename](https://man7.org/linux/man-pages/man2/rename.2.html) — `LINUX_INTERFACE_DOCUMENTATION`, Description; EXDEV; RENAME_NOREPLACE, 확인 2026-10-03. 사실 요약: 지원되는 rename은 이름 변경을 원자적으로 수행하지만 다른 mount 사이에서는 EXDEV가 발생한다. 한계: 기존 목적지 덮어쓰기 금지와 crash durability는 단순 rename 호출만으로 얻지 못한다.
- [Linux fsync](https://man7.org/linux/man-pages/man2/fsync.2.html) — `LINUX_INTERFACE_DOCUMENTATION`, Description, 확인 2026-10-03. 사실 요약: 파일 fsync만으로 부모 directory entry의 저장까지 보장하지 않아 directory에 별도 fsync가 필요하다. 한계: 이 인터페이스의 지원·오류·저장장치 보장은 플랫폼과 파일시스템별로 확인해야 한다.
- [Node.js 22 file system API](https://nodejs.org/docs/latest-v22.x/api/fs.html) — `OFFICIAL_DOCUMENTATION`, fsPromises.copyFile, 확인 2026-10-03. 사실 요약: copyFile은 atomic copy를 보장하지 않고 기본적으로 기존 목적지를 덮어쓴다. 한계: 복사 성공을 복원 트랜잭션이나 crash 후 복구 보장으로 해석할 수 없다.
- [Windows file naming rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) — `OFFICIAL_DOCUMENTATION`, Naming Conventions, 확인 2026-10-03. 사실 요약: Windows의 예약명·금지 문자·대소문자 처리와 끝점·공백 규칙을 고려해야 한다. 한계: ASCII만 사용해도 모든 filesystem 제약을 충족하는 것은 아니다.
- [Windows maximum path length](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) — `OFFICIAL_DOCUMENTATION`, Maximum Path Length Limitation, 확인 2026-10-03. 사실 요약: 전체 경로와 개별 성분의 제한은 API·설정·볼륨에 달려 있으며 성분 최대치는 흔히 255자다. 한계: 고정된 하나의 경로 길이 값으로 모든 OS와 복원 root를 지원한다고 주장할 수 없다.
- [Time Clocks and the Ordering of Events](https://lamport.org/pubs/time-clocks.pdf) — `PEER_REVIEWED_AUTHOR_COPY`, The Partial Ordering pp 558–559, 확인 2026-10-03. 사실 요약: 사건의 happened-before 관계는 부분 순서이며 물리 시각만으로 분산 인과관계를 결정할 수 없다. 한계: USL의 actor·삭제 보존·충돌 해결 정책을 직접 정의하지 않는다.
- [Syncthing Block Exchange Protocol v1](https://docs.syncthing.net/specs/bep-v1.html) — `IMPLEMENTATION_PROTOCOL`, FileInfo; Vector; Counter, 확인 2026-10-03. 사실 요약: FileInfo는 삭제 표시와 device counter 기반 version vector를 분리해 표현한다. 한계: 파일 동기화 프로토콜이며 별도 보존 백업이나 의미적 병합의 보증은 아니다.
- [Automerge conflicts](https://automerge.org/docs/reference/documents/conflicts/) — `OFFICIAL_DOCUMENTATION`, What is a Conflict, 확인 2026-10-03. 사실 요약: 동시 property 변경은 결정적인 표시값을 선택하면서 다른 충돌값을 보존한다. 한계: 결정적 수렴은 owner 의도·권한·의미상 올바른 병합을 보장하지 않는다.
- [Automerge Binary Document Format](https://automerge.org/automerge-binary-format-spec/) — `OFFICIAL_FORMAT_SPECIFICATION`, Operation, 확인 2026-10-03. 사실 요약: Operation ID는 actor ID와 actor별 증가 counter로 구성된다. 한계: 이미 저장된 actor state를 복제한 두 기기의 충돌을 저절로 방지하지 않는다.
- [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html) — `IETF_INTERNET_STANDARD`, 13.1.1 If-Match; 13.2, 확인 2026-10-03. 사실 요약: Origin은 현재 validator와 If-Match 전제조건을 비교해 실패하면 해당 변경을 수행하지 않는다. 한계: Owner가 이 조건부 인터페이스를 제공해야 하며 exactly-once 보장은 아니다.
- [Idempotency Key header draft 07](https://www.ietf.org/archive/id/draft-ietf-httpapi-idempotency-key-header-07.html) — `IETF_EXPIRED_INTERNET_DRAFT`, 2.2–2.5; Datatracker status, 확인 2026-10-03. 사실 요약: 초안은 key 재사용과 payload 일치·만료·서버 지원 확인을 구분한다. Datatracker에서 만료·보관 상태를 확인했다. 한계: 2025-10-15 revision, 2026-04-18 만료 상태다. RFC 또는 채택 완료 표준으로 취급하지 않는다. [상태 기록](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).
- [SHACL 2017 Recommendation](https://www.w3.org/TR/2017/REC-shacl-20170720/) — `W3C_RECOMMENDATION`, 2.1.4; 3.5; 3.6.1.1, 확인 2026-10-03. 사실 요약: Severity와 validation result를 표현한다. Recommendation의 conforms는 결과가 없을 때 true다. 한계: Warning 자체가 숫자 웨이트나 응용 프로그램의 차단 정책을 정의하지 않는다.
- [SHACL 1.2 Core 2026 Working Draft](https://www.w3.org/TR/2026/WD-shacl12-core-20260918/) — `W3C_WORKING_DRAFT`, Status; Conformance Checking, 확인 2026-10-03. 사실 요약: 2026-09-18 문서는 Working Draft이며 severity 기반 conformance 설정을 제안한다. 한계: 채택 완료 Recommendation이 아니며 이 저장소의 검증 기준을 자동 대체하지 않는다.
- [W3C PROV O](https://www.w3.org/TR/prov-o/) — `W3C_RECOMMENDATION`, Entity; Activity; Agent; wasAttributedTo; wasDerivedFrom, 확인 2026-10-03. 사실 요약: Entity·Activity·Agent와 귀속·파생 관계로 출처를 기술한다. 한계: 귀속과 파생은 사실의 진실성·신뢰도·접근 권한의 검증이 아니다.
- [RDF Dataset Canonicalization 1.0](https://www.w3.org/TR/rdf-canon/) — `W3C_RECOMMENDATION`, 4 Canonicalization, 확인 2026-10-03. 사실 요약: RDF dataset의 동형성에 대해 안정된 canonical 표현을 만드는 알고리즘을 정의한다. 한계: 임의의 의미 동등성·owner 자원 정체성·권한을 판정하지 않는다.
- [RFC 8785 JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html) — `IETF_INFORMATIONAL`, 3 Detailed Operation, 확인 2026-10-03. 사실 요약: I-JSON 조건과 primitive 직렬화·정렬 규칙을 포함한 JSON canonicalization을 정의한다. 한계: USL의 기존 정렬된 객체 digest가 이 명세와 완전히 호환된다고 아직 검증하지 않았다.
- [Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) — `W3C_RECOMMENDATION`, 4.2 Selectors; 4.3 States, 확인 2026-10-03. 사실 요약: TextQuoteSelector의 exact·prefix·suffix와 위치 selector 및 representation State를 정의한다. 한계: 같은 인용문이 여러 번 나오거나 내용이 바뀌면 selector만으로 정체성이 확정되지 않는다.
- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/) — `OFFICIAL_DOCUMENTATION`, Description, 확인 2026-10-03. 사실 요약: lockfile 불일치면 종료하며 lockfile을 수정하지 않는 설치 방식이다. 설치 구성에 영향을 준 옵션도 맞아야 한다. 한계: 모든 플랫폼에서 같은 실행 결과 또는 오프라인 의존성 가용성을 보증하지 않는다.
- [Reproducible Builds definition](https://reproducible-builds.org/docs/definition/) — `PROJECT_ENGINEERING_GUIDANCE`, Definition; Explanations, 확인 2026-10-03. 사실 요약: 같은 source·build environment·instructions에서 명시한 산출물을 byte 단위로 재현하는 것을 기준으로 삼는다. 한계: 작업환경을 복사했다는 사실만으로 재현성이나 다른 플랫폼의 실행 가능성이 성립하지 않는다.

규칙의 severity, 실제 차단 정책, soft penalty coefficient, HSWM W 추정치, provenance 신뢰도, 권한은 서로 다른 필드다. 특히 현재 정책 감점 계수를 HSWM W 전체의 구현으로 보지 않는다. RDFC 역시 RDF dataset 동형성에 대한 정규화이며 원문의 의미·자원 소유권을 판정하지 않는다.

## 연구 그래프와 검증 범위

[원본 조사 데이터](../research/portability-research/research.json), [USL graph](../research/portability-research/graph.json), [JSON-LD](../research/portability-research/graph.jsonld), [typed RDF trace](../research/portability-research/trace.jsonld), [역할 profile](../research/portability-research/profile.json), [SHACL shapes](../schemas/portability-research/research.shacl.ttl)를 제공한다. 기존 PT01–PT07 작업과 R01–R07 요구사항 ID를 재사용한다. 공유 KG에는 쓰지 않았으며 이 로컬 어휘는 승인된 정전으로 승격하지 않았다.

| 관계 | domain → range와 방향 | Cardinality | 의미 |
|---|---|---|---|
| supported_by | Decision → Source | 각 link의 역할은 정확히 1개 | Source informs an AI inference; not a normative implementation mandate or proof |
| inspects | Decision → LocalSource | 각 link의 역할은 정확히 1개 | Decision inspects this exact local code snapshot |
| implements_task | Decision → Task | 각 link의 역할은 정확히 1개 | Proposed implementation placement; does not mark task completed |
| addresses | Decision → Requirement | 각 link의 역할은 정확히 1개 | Decision addresses an interpreted requirement from the initial plan |
| validated_by | Decision → AcceptanceCheck | 각 link의 역할은 정확히 1개 | Proposed acceptance criterion; execution remains NOT_RUN |
| depends_on | Decision → Decision | 각 link의 역할은 정확히 1개 | Decision requires a prerequisite design; only this predicate is a DAG |
| observes | Observation → LocalSource | 각 link의 역할은 정확히 1개 | Bounded observation of a pinned implementation; no general runtime guarantee |

각 decision은 근거·코드·작업·요구사항·인수기준을 하나 이상 갖고, 인수기준은 한 decision에 귀속한다. dependencies만 DAG로 검증한다. PROV-O의 wasDerivedFrom·wasAttributedTo·wasGeneratedBy로 판단의 출처와 작성 활동을 연결하며 출처를 권한으로 읽지 않는다.

- 각 설계판단은 어떤 원문 근거와 코드 snapshot에 연결되는가?
- 요구사항별로 어느 작업과 미실행 인수기준이 연결되는가?
- 선행 설계 결정의 DAG는 순환이 없는가?
- 실제 local probe의 관측은 어느 코드 버전에 관한 것인가?
- 확정 표준·초안·만료 초안과 AI 제안을 구별하는가?

독립 Python 검증기는 실제 SPARQL 결과의 endpoint 집합을 입력 데이터와 비교하고 SHACL로 타입·필수 관계·상태를 검사한다. 미래 인수기준은 모두 NOT_RUN이다. 인터넷 원문 bytes를 보관하거나 해시 검증했다고 주장하지 않으며 URL·절·상태·확인일을 기록한다. 코드 파일은 Git revision과 실제 bytes digest를 대조한다.

```sh
node --import tsx scripts/build-portability-research.ts
node --import tsx scripts/build-portability-research.ts --check
python3 scripts/validate-portability-research.py
```

빌더와 check는 4개 순수 probe를 실행한다. 이것은 복원·내구성·분산 효과에 대한 인수검사가 아니다. Python 환경은 기존 scripts/requirements-standards.txt를 따른다. [최초 계획](PORTABILITY_PLAN.md)과 [PT01 구현 범위](PORTABLE_TRANSFER.md)를 함께 읽으면 현재 구현과 남은 작업을 구분할 수 있다.
