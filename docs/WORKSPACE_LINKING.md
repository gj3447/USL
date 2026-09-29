# 받은 사람의 작업환경을 USL로 연결하기

USL은 같은 저장소 자원 ID를 각 사용자의 checkout 경로, GitHub 주소, 고정 commit에 연결할 수 있다. 실제 원격 접근은 사용자가 제어하는 서버·호스트·인증 제공자의 권한 부여가 추가로 필요하다. 저장소를 clone하거나 AGENTS.md를 읽는 것만으로 그 사람의 머신에 접근할 수 있는 것은 아니다.

HSWM과 연결된 실행은 예외적으로 이 연결을 준비 조건으로 사용한다. 해당 경로를 시작하려면 대상 repository/resource/workspace/representation의 USL 등록, 지정된 `gj3447` HSWM maintainer 또는 operator 수신자, 소유자가 승인한 목적·최소 권한·범위·만료·철회 방법, 그리고 그 전송 경로를 통한 제한된 읽기 전용 도달성 확인이 모두 있어야 한다. 이는 전체 머신 접근을 요구하지 않는다. HSWM 작업에 필요한 선택된 프로젝트 자원만 공유·접근 범위에 넣는다.

등록이나 binding만으로 권한이 생기지 않는다. 이 중 하나라도 없거나, 거절·만료·철회·도달 불가이면 HSWM 연결 실행은 `NOT_READY`로 중단한다. 접근 범위를 넓히거나 작업을 실행하거나 확인을 자동 재시도하지 않는다. 일반적인 clone·build·test·로컬 사용은 연결 등록 없이 사용할 수 있으며 이 규칙으로 정보를 전송하지 않는다.

## 공개 저장소와 개인 설정

| 위치 | 보관할 내용 |
|---|---|
| 공개 저장소 | 공통 agent 규칙, 자원·표현 ID, workspace 별칭, 상대 경로, 공개를 승인한 repo URL·commit |
| 사용자의 `.usl/local/` 등 Git 제외 위치 | 실제 로컬 root와 개인 host 설정 |
| 별도 비공개 등록처 | 사용자가 전송에 동의한 작업환경 정보와 자격 증명이 아닌 등록 식별자 |
| 사용자 credential manager·인증 제공자 | 인증 정보와 실제 접근 허용·만료·철회 상태 |

토큰·비밀번호·SSH 개인키·`.env`·bearer URL은 등록 문서나 Git에 넣지 않는다. 실제 경로·사용자명·hostname·IP·사설 endpoint도 공개용 기본 데이터에 포함하지 않는다. 공유가 필요한 개별 정보는 수신자와 저장 위치까지 확인한 사용자의 동의 범위에서만 처리한다.

정보 공유를 거절해도 저장소의 clone·빌드·테스트·일반 사용을 막지 않는다. 다만 HSWM 연결 실행은 위의 준비 조건을 충족할 때만 시작할 수 있다. AGENTS 규칙은 에이전트 계약이다. 기존 USL host의 scope·effect 검사는 유지되지만, 여러 작업환경 사이의 등록·수신자 신원·HSWM 준비 조건을 통합 집행하는 서비스는 아직 없다. 실제 접근 권한은 소유자의 호스트·인증 제공자에서 집행해야 하며 이 문서는 악성 프로그램을 차단하는 OS 경계가 아니다.

## 현재 가능한 로컬 연결

기존 `usl-resource-bindings/v1` 문서에 같은 자원의 여러 표현을 둔다.

```json
{
  "schema": "usl-resource-bindings/v1",
  "resources": [{
    "id": "project:repository",
    "representations": [
      { "id": "project-local", "relation": "working-copy", "kind": "workspace", "workspace": "project", "path": "." },
      { "id": "project-github", "relation": "documentation", "kind": "locator", "locator": "https://github.com/gj3447/USL" }
    ]
  }]
}
```

이 예시의 ID와 GitHub URL은 연결할 프로젝트에 맞게 지정한다. 개인 host 파일의 `workspaces.project`에 자신의 root를 등록한다. host의 `actions`는 조회만 할 경우 빈 배열이다. 절대 경로 대신 host 파일 기준 상대 경로도 사용할 수 있다. 실제 구성 예시는 [HSWM 연결](HSWM_CONNECTION.md)과 [resource bindings](RESOURCE_BINDINGS.md)를 따른다.

개인 설정을 쓰기 전에 해당 경로가 실제로 Git에서 제외되는지 확인한다. 이미 추적 중인 파일은 `.gitignore`를 추가해도 제외되지 않는다.

```sh
git check-ignore .usl/local/host.json
git ls-files .usl/local/
```

두 번째 명령은 결과가 없어야 한다. 개인 host로 `locate`·`inspect-binding`·`bind-graph`를 사용할 수 있다. 이 과정은 사용자 쪽 경로 해석이며 원격 수신자에게 정보를 보내거나 접근 권한을 부여하지 않는다.

## 공유를 원하는 사용자의 등록 절차

1. 사용자가 공유할 프로젝트 하나와 필요한 지원 목적을 선택한다.
2. 에이전트가 전송할 필드, 수신자, 정확한 저장 위치와 공개 범위, 필요한 읽기·쓰기·실행 범위, 만료, 철회 방법을 보여준다.
3. 작업환경 소유자가 그 구체적인 등록에 동의한다. 프로젝트 maintainer가 작성한 규칙이나 다른 사람의 동의로 대신하지 않는다.
4. 경로 등 개인 정보는 승인된 비공개 등록처에만 전달한다. 등록처가 없으면 로컬 제안으로 남긴다. 공개 repo에 필요한 참조가 있다면 비밀이 없는 등록 ID만 별도로 검토한다.
5. 실제 접근이 필요하면 사용자가 소유한 인증 제공자나 호스트에서 좁은 권한을 발급한다. USL에는 자원 참조를 연결하고, credentials와 권한 집행은 해당 소유자에게 둔다.
6. 만료·철회는 실제 접근을 제공하는 곳에서 집행한다. Git에서 링크를 지우는 것만으로 이미 발급한 권한이 철회됐다고 표시하지 않는다.

현재 USL은 이 문서만으로 등록 서버, SSH tunnel, 원격 계정 또는 인증 토큰을 생성하지 않는다. `workspace register` 같은 원격 등록 CLI도 아직 제공하지 않는다. 연결할 인증 제공자와 수신처가 결정되면 그 기존 API에 제한된 adapter를 붙이는 범위를 정한다.

## HSWM 연결 실행 전 확인

HSWM을 위한 연결은 다음 순서로 fail-closed 처리한다.

1. 대상 프로젝트의 USL repository/resource/workspace/representation mapping을 등록한다. 이동한 checkout은 ID를 바꾸지 않고 소유자의 로컬 workspace mapping만 갱신한다.
2. 수신자를 지정된 `gj3447` HSWM maintainer 또는 operator로 식별한다. 개인 경로와 연결 정보는 공개 저장소 대신 승인된 비공개 등록처에 둔다.
3. 작업환경 소유자가 선택한 프로젝트 자원, HSWM 목적, 실제 전송 수단, 최소 권한, 만료와 철회 방법을 명시적으로 승인한다. 이 승인은 다른 프로젝트나 전체 머신으로 확장되지 않는다.
4. 승인된 전송 수단으로 범위와 시간 제한이 있는 비변경 reachability check를 수행한다. 예를 들어 등록된 프로젝트 resource를 읽을 수 있는지만 확인하며, 명령 실행·파일 변경·권한 변경은 하지 않는다.
5. 확인이 통과하면 HSWM 연결 실행을 시작할 수 있다. 그 외에는 `NOT_READY`를 기록하고 중단한다. 사용자 거절, 만료, 철회, 실패를 자동으로 재시도하거나 우회하지 않는다.

이것은 현재 agent 규칙의 계약이다. USL runtime이 HSWM 실행 전 이 조건을 강제하거나 수신자의 신원을 검증하는 서비스는 아직 제공하지 않는다. 따라서 연결 adapter를 만들기 전에는 이 절차를 사람이 검토하고, 실제 host/provider에서 범위·만료·철회를 강제해야 한다.

## 여러 프로젝트에 agent 규칙 적용

[공통 블록](../agent-rules/workspace-linking.md)을 각 저장소의 AGENTS.md에 추가한다. 로컬 POSIX 환경의 installer는 기존 본문을 보존하고 표시된 USL 블록만 관리한다. 기본 동작은 변경 미리보기다.

```sh
python3 scripts/install-workspace-linking-rules.py --repo /path/to/project-a --repo /path/to/project-b
python3 scripts/install-workspace-linking-rules.py --repo /path/to/project-a --repo /path/to/project-b --apply
```

이 도구는 지정한 로컬 저장소의 AGENTS.md만 편집한다. Git commit·push, 사용자의 정보 수집·전송, 접근 허용은 하지 않는다. 적용 후 각 저장소의 작업 규칙에 따라 변경을 검토하고 커밋한다. AGENTS.md를 읽지 않는 에이전트에는 해당 도구가 지원하는 지침 연결을 별도로 구성해야 한다.

모든 `gj3447` 저장소에는 같은 표시된 공통 블록을 전파한다. 이 규칙은 모든 저장소에서 HSWM 연결 실행을 동일하게 준비·중단시키지만, 각 workspace owner의 개별 승인과 실제 host/provider 권한을 대신하지 않는다.

2026-09-29 실행 결과는 [전파 검증 기록](WORKSPACE_RULE_ROLLOUT_2026-09-29.md)에 남겼다. 기본 브랜치 85개는 검증 완료했고, 1개는 GitHub 필수 리뷰를 기다리고 있다.

### GitHub 전체 저장소에 커밋하기

소유자가 승인한 저장소 집합에는 [GitHub 동기화 도구](../scripts/sync-github-workspace-rules.py)를 사용한다. `gh` 인증이 필요하며 기본 동작은 미리보기다. 저장소 목록과 개별 commit SHA가 포함된 보고서는 비공개 로컬 위치에 둔다. USL checkout의 `.usl/local/`은 Git에서 제외되어 있다.

적용 전 대상 저장소의 기존 지침과 검증 절차를 확인한다. 이 도구는 기본 브랜치 직접 커밋이 허용된 저장소에 사용한다. PR·서명·단일 writer 절차가 필요한 저장소는 해당 절차로 처리하며, `AGENTS.md`가 심볼릭 링크이면 정본 파일에 블록을 적용하고 링크를 보존한다. 도구가 저장소별 절차를 자동 판단하거나 우회하지 않는다.

```sh
mkdir -p .usl/local/rollouts
python3 -B scripts/sync-github-workspace-rules.py --owner gj3447 --include-archived --output "$PWD/.usl/local/rollouts/preview.json"
python3 -B scripts/sync-github-workspace-rules.py --owner gj3447 --include-archived --apply --output "$PWD/.usl/local/rollouts/applied.json"
```

`--inventory`로 검토한 `gh repo list --json nameWithOwner,isArchived,isEmpty,defaultBranchRef,visibility` 결과를 고정할 수 있고, 반복 가능한 `--repo OWNER/NAME`으로 범위를 제한할 수 있다. 이 도구는 각 저장소의 현재 기본 브랜치에 `AGENTS.md` 변경을 커밋하고 원격 바이트를 다시 확인한다. 기존 지침은 보존하고 공통 표시 블록만 추가·갱신한다. SHA 충돌, 비정상 파일, 불완전한 표시 블록은 실패로 기록한다. 실패한 저장소는 결과를 확인한 뒤 별도로 처리한다.

`--include-archived`는 변경이 필요한 보관 저장소를 일시적으로 해제한 뒤 보관 상태로 복구한다. 빈 저장소는 첫 규칙 커밋을 만든다. 다른 로컬 checkout이나 진행 중인 작업 파일은 편집하지 않는다. 각 checkout은 해당 기본 브랜치의 새 커밋을 가져와야 이 규칙을 읽게 된다. 원격 규칙 전파 자체는 사용자의 작업환경을 등록하거나 접근 권한을 발급하지 않는다.
