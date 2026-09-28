# USL 표준 그래프 공학 방향 검토

기준일: **2026-09-28**. 이 문서는 공개 1차 명세와 현재 저장소를 대조한 설계 검토다. `GEIP GraphSpec v0alpha1`은 이 프로젝트가 보존·검사하는 **로컬 draft 계약**이며, W3C·IETF·SLSA·in-toto·MCP의 보편 표준이라고 주장하지 않는다.

## 확인한 사실

### 자원 identity와 여러 표현

[W3C PROV-DM](https://www.w3.org/TR/prov-dm/)에서 `specializationOf`는 더 일반적인 entity의 모든 측면을 공유하면서 더 구체적인 측면을 제시하는 entity를 뜻한다. `alternateOf`는 같은 underlying thing의 서로 다른 측면을 제시한다. [PROV-CONSTRAINTS](https://www.w3.org/TR/prov-constraints/)는 alternate를 동치 관계로, specialization을 strict partial order로 둔다.

따라서 로컬 checkout, pinned Git blob, HTTPS 문서가 같은 자원일 수 있다는 사실은 자동으로 성립하지 않는다. 특히 working copy와 commit은 시간·내용 측면이 다르고, 문서 URL은 구현물의 alternate라는 근거가 없을 수 있다. USL의 `usl-resource-bindings/v1`이 stable resource ID, representation ID, `working-copy`/`snapshot`/`documentation`/`mirror` 관계와 명시적 선택을 분리하고 자동 alias/equivalence를 거부하는 방향은 PROV의 강한 `alternateOf` 주장보다 보수적이다. 이는 사실의 자동 생성 대신 owner assertion과 digest 검증을 요구하는 판단이다.

[RFC 8141](https://datatracker.ietf.org/doc/html/rfc8141)은 URN 문법을 정의하고 이전 URN 문법을 대체한다. `urn:usl:...`이나 `urn:usl:runtime:...`는 문법상 identifier로 쓸 수 있지만, RFC만으로 namespace 등록·해결·영속성·소유권이 보장되지는 않는다. 그러므로 USL resource ID를 locator나 접근 권한으로 해석해서는 안 된다.

### provenance, 실행, 검증

[SLSA Build levels v1.2](https://slsa.dev/spec/v1.2/build-levels)은 build provenance가 artifact를 누가·어떤 process·입력으로 만들었는지 설명하며, 높은 수준은 provenance/build tampering에 대한 보호를 늘린다고 정의한다. [Build requirements v1.2](https://slsa.dev/spec/v1.2/build-requirements)는 output digest와 생산 과정을 식별하는 provenance 생성을 요구한다. 이는 build artifact provenance의 신뢰성 모델이며, 임의 CLI action의 업무 효과, 원격 side effect의 exactly-once, 의미 관계의 참을 증명하는 규격은 아니다.

[in-toto](https://in-toto.io/docs/getting-started/)는 owner-signed layout, authorized functionary가 남긴 signed link metadata, materials/products와 command를 연결해 supply-chain step을 검증한다. link가 기록하지 않은 material/product는 실제로 사용·수정되었더라도 그 link가 입증하지 않는다. USL의 intent/result receipt, source/argv/plan pin은 in-toto와 닮은 audit data이지만 현재 서명된 layout/link, functionary key, artifact rule verification을 구현하지 않았다. 따라서 receipt는 host-reported local evidence다.

### MCP와 skills의 위치

[MCP server specification 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/server)은 prompt를 user-controlled, resource를 application-controlled, tool을 model-controlled primitive로 구분한다. tool은 action을 수행하거나 data를 읽는 executable function이다. 이 구분은 USL에서 skill을 재사용 가능한 작업 지침·문서로, MCP를 discovery/context/action transport로, host-registered CLI action을 실제 local-process authority boundary로 분리하는 판단을 뒷받침한다. MCP tool description 또는 skill text는 실행 authority가 아니다.

### durable execution

[Google Cloud Workflows retry 문서](https://docs.cloud.google.com/workflows/docs/reference/syntax/retrying)는 retry predicate·횟수·backoff를 별도 정책으로 정의한다. [callback 문서](https://docs.cloud.google.com/workflows/docs/creating-callback-endpoints)에서 callback은 idempotent라고 명시하지만, 이는 해당 callback 기능의 계약이다. [AWS의 idempotent API 설계 글](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)은 재시도 안전성을 위해 같은 client request identifier에 같은 의미의 결과를 주는 계약과 서버 측 중복 식별이 필요함을 설명한다.

이는 USL의 `INDETERMINATE`와 “자동 재시도 금지”가 타당한 이유다. intent 파일을 먼저 쓰고 process 결과를 receipt로 남기는 것만으로 외부 effect가 한 번만 일어났음을 보장할 수 없다. durable runtime에는 stable idempotency key, remote-side conditional write 또는 query, retry policy, timeout 뒤 reconciliation, human/owner decision이 필요하다.

## 현재 USL과의 대조

| 영역 | 현재 구현 | 주장 가능한 범위 | 남은 결함 |
|---|---|---|---|
| identity/representation | `src/resource-bindings.ts`의 stable resource ID, explicit representation, realpath containment | 경로 이동 뒤 stable ID 유지, 선택하지 않은 여러 표현의 모호성 거부 | owner가 alternate/specialization을 주장·서명·검증하는 모델 없음; content digest는 optional declaration |
| graph | `src/integrations/graph-engineering.ts`, `src/cli-host.ts` | GraphSpec digest와 one `code`/`tool` entry node pin, dangling/incoming dependency 거부 | lifecycle, gate, loop, effect policy, complete workflow 실행 없음; `wholeGraphExecution: NOT_EXECUTED` |
| capability/authority | descriptor+policy preflight, registered CLI host | effect/scope/schema/source pin의 실행 전 거부, fixed argv/working directory | policy signer, delegation/revocation history, remote authorization proof 없음 |
| evidence | plan, intent, result, input/source/output digests | 한 local attempt와 host-observed output의 재현 단서 | receipt 서명·append-only store·external timestamp·SLSA/in-toto verification 없음 |
| Lean | 37 Lean model theorems과 TS 대조 | 탐색/역할/예산 모델의 정리 | TS runtime refinement, resolver/process/CLI host, digest/realpath, graph lifecycle·external effects의 증명 없음 |
| MCP/skills | MCP discovery/preflight와 local skill | context/discovery와 실행 authority 분리 | MCP action을 durable host process와 공통 receipt/reconciliation으로 연결하지 않음 |

Lean 범위는 [LEAN4_INTEGRATION.md](../../docs/LEAN4_INTEGRATION.md)와 [증명 기록](../../audit/LEAN_PROOFS_2026-09-14.md)에 명시된 37개 정리로 한정한다. 이 정리들은 Lean 모델의 hypergraph 탐색·역할·허용 read·예산 성질이다. TypeScript parser/compiler/hash/BFS 전체, locator normalization, `resource-bindings`, `cli-host`, subprocess, 외부 IO 및 사용자 의미 대응은 refinement proof 대상이 아니다.

## 판단: 다음 우선순위

1. **receipt persistence와 reconciliation 계약을 먼저 만든다.** action ID + plan digest + caller-supplied idempotency key를 durable store에 unique하게 기록하고 `ATTEMPTING`, `SUCCEEDED`, `INDETERMINATE`, `RECONCILED` 상태와 owner reconciliation callback을 정의한다. 자동 retry는 target capability가 idempotency key와 상태 조회를 명시적으로 지원할 때만 허용한다.
2. **authority provenance를 추가한다.** host config/action/policy/binding의 signer 또는 trusted local owner identity, delegation 기간, revocation revision을 receipt와 graph evidence에 연결한다. 서명 없는 JSON은 local configuration snapshot으로 표시한다.
3. **표준 provenance exporter/importer를 작게 추가한다.** PROV-O JSON-LD로 resource representation, activity, agent, plan, receipt를 내보내고, SLSA/in-toto는 verified input artifact가 있을 때만 reference/pin으로 연결한다. 자체 receipt를 SLSA provenance 또는 in-toto attestation이라고 이름 붙이지 않는다.
4. **GraphSpec runtime은 별도 phase로 둔다.** 현재 entry-node runner를 workflow engine으로 확장하지 않는다. 먼저 lifecycle transition, declared precondition evaluation, idempotency/reconciliation, gate authority의 명세와 test matrix를 만들고 그 뒤 bounded dispatcher를 구현한다.
5. **Lean은 모델-구현 연결을 좁게 증명한다.** parser/compiler가 생성한 finite plan과 Lean model의 encoding, navigation result의 soundness부터 검증한다. process/IO는 명세화한 boundary event와 receipt state machine에 대해 다룬다.

## 결론

현재 경로는 “표준 그래프 공학을 참조해 evidence·identity·authority를 엄격히 구분하는 local engineering runtime”으로는 일관된다. 그러나 durable orchestration, international-standard conformance, signed supply-chain provenance, full GraphSpec workflow execution을 이미 제공한다고 표현하면 안 된다. 다음 구현은 graph executor 확장이 아니라 durable idempotency/reconciliation 및 authority provenance여야 한다.
