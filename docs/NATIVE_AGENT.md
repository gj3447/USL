# Native agent harness

P10은 owner가 관리하는 에이전트 실행 경로 하나를 [P08 원문 전달과 P09 CLI dispatcher](NATIVE_PROFILE.md)에 연결한다. 한 turn마다 필수 원문을 고정된 순서로 읽고 모델을 **한 번** 호출한다. 모델이 제안한 도구 호출은 등록된 `usl_action` 하나에 한해 P09 검증을 거쳐 실행한다. 자동 반복·재시도·다중 도구 실행은 없다.

## 원문과 실행의 연결

`instructionOrder`는 활성 manifest의 `requiredSources` ID·순서와 정확히 같아야 한다. 각 자료의 revision·전체 문서 digest·byte 길이·selector를 P08에서 검사하고 원문 전체를 각각 system message에 넣는다. JSON Pointer도 전체 backing document를 전달한다. UTF-8 변환이 원본 bytes를 보존해야 하며, 전체 문맥이 예산을 넘으면 HOLD한다. 원문을 임의로 자르거나 일부 규칙을 생략하지 않는다.

전달 ACK는 **harness가 해당 내용을 문맥에 넣었다는 확인**이다. API 수신, 모델의 이해, 실제 규칙 준수를 증명하지 않는다. 실행을 제한하는 것은 P09의 입력 계약·등록 evaluator·현재 환경 재검사·일회성 허가·durable gate다. 모델은 도구 이름이나 owner가 고정한 action·명령·경로·권한을 바꿀 수 없다. 도구에 전달한 JSON 입력의 실제 의미는 owner가 등록한 프로그램과 계약이 책임진다.

등록·callback·descriptor·정책 pin은 비동기 작업 전에 캡처한다. 모델 호출 전후의 활성 profile을 확인하며 P09에서 다시 환경을 관측한다. worktree나 컴퓨터가 바뀌면 먼저 새 owner mapping과 profile로 전환해야 한다. 옛 문맥의 허가를 새 환경에 가져가서 쓰지 않는다.

## SDK 사용

```ts
import {
  createNativeAgentSession, runNativeAgentTurn,
  invalidateNativeAgentSession, handoffNativeAgentSession,
} from "usl/native-agent"
import { createNativeAgentChatModel } from "usl/native-agent-http"

// 아래 등록·callback·자료는 owner가 별도로 공급한다.
const model = createNativeAgentChatModel({
  id: privateModelRegistration.id,
  endpoint: privateModelRegistration.endpoint,
  model: privateModelRegistration.model,
  getAuthorization: () => modelAuthHeader(),
})
const session = createNativeAgentSession({
  harnessId: privateModelRegistration.harnessId,
  model, dispatch: dispatchHost, tool, read: readSource,
  instructionOrder: snapshot.manifest.requiredSources.map(s => s.id),
}, { sessionId })
const turn = await runNativeAgentTurn(session, {
  invocationId, admissionId, attemptId, prompt,
})
// turn.report.status: COMPLETED / HOLD / UNKNOWN
// COMPLETED는 모델 답변 또는 검증된 CLI 한 번 실행이며, 전체 목표 완료가 아니다.

// host에서 문맥 압축을 감지했을 때 호출한다.
invalidateNativeAgentSession(session, "COMPACTION")
// 새 turn은 새 invocation ID와 원문 전달을 요구한다.

// childHost도 owner가 등록한 별도 target을 가져야 한다.
const child = handoffNativeAgentSession(session, childHost, { sessionId: childSessionId })
// 부모는 닫히고 child는 원문과 실행 허가를 새로 준비한다.
```

각 turn은 이전 대화나 전달 handle을 재사용하지 않는다. 압축은 epoch를 올리고 활성 작업을 취소·철회하며 다음 turn을 허용한다. `HANDOFF`, `TARGET_LOST`, `CLOSED`는 session을 닫는다. host가 실제 문맥 변경 시 이 API를 호출해야 한다. SDK가 다른 앱의 compaction이나 임의 subagent를 자동 감지하는 것은 아니다.

session은 process-local opaque 객체다. 복사·직렬화한 객체, 같은 session의 동시 turn·invocation 재사용은 HOLD한다. session당 invocation은 최대 1,024개이며 자동 삭제하지 않는다. 모델 호출 제한시간은 기본 30초, 전달은 15초이고 각각 최대 60초다. 문맥은 기본 1 MiB, 최대 4 MiB의 JSON byte 예산이다. 토큰 예산과 같지 않으며 모델 context window와 template 호환성은 별도 확인해야 한다.

callback 취소는 협력적이다. 취소를 무시하는 임의 owner 코드를 강제 종료하지는 않는다. timeout이나 불명 외부 효과는 UNKNOWN이 될 수 있으며 자동 재시도하지 않는다. P09의 gate가 남았으면 기존 owner 복구 절차를 따른다. 외부 효과와 파일·HTTP 관측의 원자성, 복제·롤백된 registry 사이의 전역 exactly-once는 보장하지 않는다.

## DGX 및 HTTP 모델 연결

`createNativeAgentChatModel`은 owner가 지정한 전체 `/chat/completions` endpoint로 POST한다. 모델명과 endpoint를 자동 탐색하거나 다른 서버로 전환하지 않는다. HTTPS가 기본이고 `allowHttp: true`는 owner가 명시적으로 선택한 HTTP 연결용이다. 리다이렉트와 재시도는 금지하며 credential URL·query·fragment는 받지 않는다. 인증 헤더는 runtime callback으로 공급하고 trace·등록 digest에 넣지 않는다.

요청에는 **필수 원문 전체·사용자 prompt·도구 설명과 입력 schema**가 포함된다. 실제 endpoint·등록·인증 연결은 무시되는 `.usl/local/` 설정 등 owner의 비공개 구성에 둔다. 외부로 자료를 보내려면 [owner 규칙](agent-rules/OWNER.md)의 수신자·필드·목적·범위·만료·철회에 대한 공개 승인이 적용된다. import·설치·테스트만으로 실제 모델에 연결하지 않는다. 이번 구현의 실제 DGX 상태는 **`NOT_CONFIGURED_NOT_RUN`**이다. 실제 주소·모델·접근 등록을 확인한 결과가 아니다.

HTTP 요청/응답은 각각 기본 1 MiB, 최대 4 MiB이고 전체 HTTP 제한시간은 기본 30초, 최대 60초다. `maxTokens`는 기본 1,024, 최대 16,384다. `stream: false`, `tool_choice: "auto"`, `parallel_tool_calls: false`로 호출한다. 정확히 하나의 choice와 최종 답변 또는 하나의 JSON object 도구 인자만 받는다. 거절·잘린 응답·다중/미등록 도구·잘못된 JSON·UTF-8·byte 초과는 실패 처리한다. unconstrained capability schema `true`는 모델에 `{ type: "object" }`로 제시하고, P09는 원래 고정한 입력 schema를 계속 검사한다. 유효한 입력이 없는 `false` schema는 session 등록 때 거부한다.

vLLM의 자동 tool choice는 `--enable-auto-tool-choice`와 모델에 맞는 parser가 필요하며 chat template 요구도 확인해야 한다. 현재 문서의 `hf` parser에는 `parallel_tool_calls: false` 제약이 있다. 호환되지 않는 서버에 대해 옵션을 제거해서 재시도하지 않는다. [vLLM 공식 tool calling 문서](https://docs.vllm.ai/en/latest/features/tool_calling/)를 2026-10-12 확인한 설계 근거이며, 실제 DGX의 버전·설정 증거는 아니다.

## 검증 범위

turn 보고서는 session/target/epoch, snapshot·host mapping·graph pin, 필수 자료의 순서·revision·digest·bytes, 모델 등록·요청·응답 digest, P09 admission·effect·CLI receipt digest를 연결한다. 원문·prompt·인증 헤더는 보고서에 저장하지 않는다. digest와 ACK는 서명된 증명이 아니며, callback과 owner 등록은 신뢰 경계다.

[에이전트 테스트](../test/native-agent.test.ts)와 [HTTP 테스트](../test/native-agent-http.test.ts)는 임시 파일·loopback 서버로 실행한다. 문맥 손실·인계·재생·잘못된 응답의 차단과 등록된 CLI 실행 연결을 검사한다. direct shell·외부 도구·계측하지 않은 subagent는 범위 밖이다. [진행 그래프](NATIVE_IMPLEMENTATION.md)의 P10은 이 제한된 구현 근거이며 P04/P07/P11/P12, 실제 DGX·HSWM·입운구 종단 연결의 완료를 뜻하지 않는다.
