# 받은 사람의 작업환경을 USL로 연결하기

USL은 같은 저장소 자원 ID를 각 사용자의 checkout 경로, GitHub 주소, 고정 commit에 연결할 수 있다. 실제 원격 접근은 사용자가 제어하는 서버·호스트·인증 제공자의 권한 부여가 추가로 필요하다. 저장소를 clone하거나 AGENTS.md를 읽는 것만으로 그 사람의 머신에 접근할 수 있는 것은 아니다.

## 공개 저장소와 개인 설정

| 위치 | 보관할 내용 |
|---|---|
| 공개 저장소 | 공통 agent 규칙, 자원·표현 ID, workspace 별칭, 상대 경로, 공개를 승인한 repo URL·commit |
| 사용자의 `.usl/local/` 등 Git 제외 위치 | 실제 로컬 root와 개인 host 설정 |
| 별도 비공개 등록처 | 사용자가 전송에 동의한 작업환경 정보와 자격 증명이 아닌 등록 식별자 |
| 사용자 credential manager·인증 제공자 | 인증 정보와 실제 접근 허용·만료·철회 상태 |

토큰·비밀번호·SSH 개인키·`.env`·bearer URL은 등록 문서나 Git에 넣지 않는다. 실제 경로·사용자명·hostname·IP·사설 endpoint도 공개용 기본 데이터에 포함하지 않는다. 공유가 필요한 개별 정보는 수신자와 저장 위치까지 확인한 사용자의 동의 범위에서만 처리한다.

이 절차는 선택 사항이다. 정보 공유를 거절해도 저장소의 clone·빌드·테스트·일반 사용을 막지 않는다. AGENTS 규칙은 에이전트에게 절차를 안내하는 문서이며, 악성 프로그램을 차단하거나 권한을 집행하는 OS 경계가 아니다.

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

## 여러 프로젝트에 agent 규칙 적용

[공통 블록](../agent-rules/workspace-linking.md)을 각 저장소의 AGENTS.md에 추가한다. 로컬 POSIX 환경의 installer는 기존 본문을 보존하고 표시된 USL 블록만 관리한다. 기본 동작은 변경 미리보기다.

```sh
python3 scripts/install-workspace-linking-rules.py --repo /path/to/project-a --repo /path/to/project-b
python3 scripts/install-workspace-linking-rules.py --repo /path/to/project-a --repo /path/to/project-b --apply
```

이 도구는 지정한 로컬 저장소의 AGENTS.md만 편집한다. Git commit·push, 사용자의 정보 수집·전송, 접근 허용은 하지 않는다. 적용 후 각 저장소의 작업 규칙에 따라 변경을 검토하고 커밋한다. AGENTS.md를 읽지 않는 에이전트에는 해당 도구가 지원하는 지침 연결을 별도로 구성해야 한다.
