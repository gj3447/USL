# CP01 · clean Git export

`exportCleanGitTransfer`는 독립적으로 지정한 HEAD와 branch refs에 필요한 Git 객체를 `CLEAN_GIT_WORKTREE_V1` 묶음으로 내보낸다. 원본 저장소 없이 검증할 수 있는 `repo.bundle`, `manifest.json`, `receipt.json` 세 파일을 만든다. checkout 복원, 여러 worktree 재생성 및 링크 재바인딩은 별도 [CP02 importer](PORTABLE_TRANSFER_GIT_IMPORT.md)가 담당한다. export manifest의 `NO_RESTORE_OR_REBIND`는 이 producer 자체의 범위를 나타낸다.

## 실행

저장소에서 `npm ci` 후 다음 CLI를 사용한다. 이 단계는 별도 개발용 스크립트이며 기존 `usl` 명령이나 npm package export에는 아직 연결하지 않았다.

```sh
node --import tsx scripts/usl-git-export.ts --help
node --import tsx scripts/usl-git-export.ts --spec /absolute/private/export.json --destination-parent /absolute/existing/output
```

아래는 입력 형식이다. `expectedHead`와 `expectedRefs`의 값은 예시 자리표시자이므로 실제로 소유자가 선택하고 확인한 전체 commit OID로 바꿔야 한다. 로컬 경로가 있는 이 입력 파일은 공유 저장소에 커밋하지 않는다. CLI의 출력 JSON에도 로컬 결과 경로가 포함된다.

```json
{
  "schema": "usl-clean-git-export/v1",
  "sourceRoot": "/absolute/selected/worktree",
  "ownerNamespace": "urn:example:owner",
  "repositoryId": "repo:example",
  "worktreeId": "worktree:example:main",
  "issuer": "urn:example:operator",
  "observedAt": "2026-10-05T00:00:00Z",
  "expectedHead": "<40-character SHA-1 commit OID>",
  "expectedRefs": { "refs/heads/main": "<40-character SHA-1 commit OID>" },
  "expectedObjectFormat": "sha1",
  "maxBundleBytes": 67108864,
  "maxUncompressedBytes": 67108864,
  "maxObjects": 100000,
  "maxDurationMs": 60000
}
```

`destinationParent`는 CLI 호출자가 플래그로 지정한다. 입력 spec에 넣으면 거부한다. API 호출에서는 같은 필드를 요청 객체에 포함한다. source와 destination은 서로 포함하지 않는 기존 절대 디렉터리여야 하며, Git 관리 디렉터리를 destination으로 사용할 수 없다. SHA-256 저장소는 `sha256`과 64자리 OID를 사용한다. refs는 1–256개의 명시적인 `refs/heads/...`만 허용한다. 현재 HEAD는 선택한 refs에 포함되지 않은 detached commit이어도 별도로 묶는다.

기본 bundle 크기와 도달 가능한 비압축 객체 크기 한도는 각각 64 MiB이며, 각 최대값은 512 MiB다. 객체 수 최대값은 100,000개, 기본 시간 제한은 60초, 최대값은 300초다. 추가로 명령 출력·진단·메타데이터와 디렉터리 항목 수에도 제한을 둔다. 이 제한은 Git 프로세스의 전체 RSS나 운영체제 I/O 시간을 보장하는 sandbox가 아니다.

## 검증과 결과

1. 요청을 복사·검증하고 source의 HEAD, refs, object format을 독립 입력 pin과 비교한다.
2. 도달 가능한 객체의 수·비압축 크기와 LFS pointer를 검사한다.
3. 네트워크·lazy fetch·Git hook·filter 실행을 차단한 Git 호출로 stdout에 bundle을 만들고, byte 한도를 지킨 payload만 임시 디렉터리에 쓴다.
4. 비어 있는 같은 object-format 저장소에서 bundle을 검증하고 실제로 `unbundle`, `fsck --strict`를 실행한다. 객체 집합과 크기도 원본에서 계산한 결과와 비교한다.
5. source의 pins·index·설정을 다시 관측하고 임시 파일의 bytes를 재확인한 뒤, 검증용 저장소를 제거하고 세 파일만 새 디렉터리로 rename한다. 실패하면 임시 산출물을 정리한다.

반환값의 `bundlePath`와 `transferPath`는 세 파일이 들어 있는 **디렉터리**다. `gitBundlePath`는 실제 `repo.bundle` 파일이다. manifest에는 실제 Git·Node 버전, 적용한 예산, bundle version 3과 빈 prerequisites를 기록한다. `manifestDigest`는 계약 canonical digest이고, `bundleByteDigest`와 `receiptDigest`는 각 실제 파일 bytes의 SHA-256이다. manifest의 digest는 구조/내용 연결 근거이며 서명이나 접근 권한이 아니다. `parseCleanGitTransferManifest`는 순수 구조·pin 일관성 검사로, payload의 무결성이나 수입 권한까지 확인하지 않는다.

## 현재 허용 범위

현재 checkout은 index·working tree에 변경이 없고 untracked 파일도 없어야 한다. shallow·alternates·grafts·replace refs·partial clone/promisor·sparse checkout·submodule·LFS pointer/filter·index masking flags·진행 중 merge/rebase 등은 거부한다. 검사 대상 경로의 symlink/special file도 거부한다. Git config·hook·credential 파일은 복사하지 않지만, 선택한 commit 이력에 포함된 추적 파일은 Git 객체에 포함된다. 묶음 생성과 공유 권한은 별개이며 이 명령은 로컬에서만 실행한다.

ignored 파일은 관측하거나 포함하지 않는다. bundle은 Git commit/tree/blob 이력과 선택한 refs를 담으며 `.git` 디렉터리의 복사본이나 전체 작업환경 백업이 아니다. 줄바꿈 변환 등으로 달라질 수 있는 실제 checkout 파일 bytes의 보존도 약속하지 않는다. `repositoryId`와 `worktreeId`는 소유자가 제공한 논리 label이며 실제 Git 관측으로 그 ID의 등록 권한까지 검증하지 않는다.

source 관측은 원자적 snapshot이 아니다. 전후 관측에서 변경이 드러나면 출판을 거부하지만, 중간에 변경했다 되돌리는 경우나 같은 OS 계정의 적대적 경로 치환까지 배제하지 않는다. 안전한 사용 조건은 export 동안 선택한 source와 destination을 변경하지 않는 것이다. Linux에서 실행한 검사는 [진행 기록](COMPLETION_PROGRESS.md)에 있으며 macOS·Windows와 실기기 이동 검증은 아직 남아 있다.

계약의 기반은 Git의 [bundle 형식과 verify](https://git-scm.com/docs/git-bundle), [rev-list 객체 순회](https://git-scm.com/docs/git-rev-list)다. `bundle verify`의 header/prerequisite 검사에 더해 실제 객체 unpack과 fsck를 수행한다.
