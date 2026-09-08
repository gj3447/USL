# AI에 전달하는 USL 맥락 줄이기

2026-09-08 · 구현된 `compactAgentContext` / `usl context --compact` 사용법.

USL의 선택 탐색으로 관련 자원을 고른 뒤, AI에 전달할 경로 정보의 중복을 줄인다. 같은 맥락을 이미 보유한 소비자는 digest를 보내 재전송을 생략할 수 있다. 의미 설명·적용 조건·검사 근거와 링크의 모든 참여 역할은 보존한다.

## CLI

```sh
npm run usl -- context --source examples/agent-navigation.usl \
  --focus concept --target checkout --compact --max-bytes 4096

# 첫 FULL 응답의 contextDigest를 사용한다.
npm run usl -- context --source examples/agent-navigation.usl \
  --focus concept --target checkout --compact --known-context 'sha256:<64자리 hex>'

# 측정 통계는 stderr, AI에 전달할 JSON은 stdout으로 분리한다.
npm run usl -- context --source examples/agent-navigation.usl \
  --focus concept --target checkout --compact --stats
```

`--out`을 사용하면 같은 압축 JSON을 파일에 저장한다. 기존 `context` 출력 형식은 유지한다. `--max-hops`, `--max-resources`, `--max-links`, `--max-visits`, `--via`로 탐색 범위를 함께 좁힐 수 있다. context 생성은 엔드포인트 내용을 읽지 않는다.

## 무엇을 줄이는가

`usl-agent-context-compact/v1`의 첫 응답은 `mode: FULL`이다. 자원·의미·링크 선언과 탐색 범위/한계를 모두 담되, 경로 단계는 `[link, enteredRole, exitedRole]` 튜플로 전달한다. `pathStepFields`에 열 이름을 한 번 기록한다.

원래 경로의 `meaning`은 링크 정의에서, 도착 자원은 `exitedRole` 참여자에서, 출발 자원은 이전 단계 또는 `focus`에서 복원한다. 목표 경로는 `paths`의 해당 자원 항목에 있으므로 `target`에 중복해서 싣지 않는다. 경로 탐색에서 제외된 맥락 참여자(`distance: null`)와 다자 관계의 전체 역할도 남는다. `semanticTruth: NOT_EVALUATED`와 `reachability: NOT_OBSERVED`도 유지한다.

`contextDigest`는 이 필드 자체를 제외한 FULL 패킷 전체의 digest다. 원본 `planDigest`, 탐색 결과·범위·한계, 의미 정의가 포함된다. `--known-context`가 정확히 일치하면 응답은 `mode: UNCHANGED`와 두 digest만 담는다. 의미 설명이나 주소, 질의 결과/범위가 바뀌면 FULL 응답으로 돌아간다.

**소비자가 이전 FULL 맥락을 여전히 사용할 수 있을 때만 known digest를 보내야 한다.** AI 세션이 바뀌거나 맥락이 지워졌다면 생략하고 FULL을 다시 받는다. 이 기능이 AI의 기억이나 호스트 캐시를 자동 관리하지는 않는다. 외부 파일 내용의 최신 여부는 별도 관측으로 확인한다.

## 바이트 예산과 토큰 예산

`maxBytes` 기본값은 8192다. 마지막 개행까지 포함한 실제 UTF-8 JSON 전달량에 적용한다. 결과가 초과하면 `BUDGET_EXCEEDED`로 실패하므로, 호출자는 탐색 범위를 좁히거나 예산을 늘린다. 의미나 다자 관계의 일부를 잘라서 완전한 결과처럼 반환하지 않는다.

TypeScript API는 사용 모델의 tokenizer를 주입할 수 있다.

```ts
const result = compactAgentContext(plan, query, {
  maxBytes: 8192,
  maxTokens: 2000,
  tokenCounter: {
    id: "your-tokenizer-and-version",
    count: (text) => tokenizer.encode(text).length,
  },
})
```

여기서 `tokenizer`는 호출자가 준비한 실제 tokenizer다. 특정 모델의 tokenizer를 기본 포함하지 않으며, counter 없는 `maxTokens`는 거부한다. counter는 전체 전달 문자열을 세고 음이 아닌 안전한 정수를 반환해야 한다. 옵션·counter 식별자·함수는 호출 시작 시 고정하므로 callback이 옵션을 수정해도 예산이 바뀌지 않는다.

`stats.baselineBytes`는 기존 v1 context의 **공백 없는 JSON + 개행** 크기다. `deliveredBytes`와 `bytesSaved`는 실제 전달 문자열을 기준으로 계산한다. `stats.tokens`는 counter를 제공한 경우에만 `{counterId, baseline, delivered, saved}`로 반환하고, 아니면 `null`이다. tokenizer 측정에는 API 메시지 포장·시스템 프롬프트·추론 토큰이 포함되지 않으므로 모델의 청구 사용량과 동일하다고 주장하지 않는다. 작은 맥락은 digest 등 부가정보 때문에 절감량이 음수일 수도 있다.

## 재현 결과

```sh
node --import tsx examples/context-budget.ts
```

[기록된 예제 결과](../examples/context-budget-result.json)는 기존 v1 전달 2,831바이트, 첫 FULL 2,316바이트, 동일 맥락 UNCHANGED 238바이트다. 의미 설명을 반전하면 FULL 2,326바이트로 다시 전달된다. 모델별 토큰 수는 측정하지 않았으며 결과에도 `tokens: null`로 기록한다.

이 구현이 줄이는 대상은 **관련 연결을 찾고 전달하는 맥락 비용**이다. 실제 소스 본문·검사 결과를 모델에 넣는 비용과 게임 작업 전체의 토큰 사용량은 해당 에이전트 연동에서 별도로 측정해야 한다.
