# USL 2차 적대적 검증 — 2026-09-08

후속 상태: 아래 새 결함 **R2-01~R2-05를 모두 보완했다.** [수정 내용과 호환성](ADVERSARIAL_FIXES_ROUND2_2026-09-08.md)을 참조한다. 아래 소스 digest와 재현 결과는 수정 전 감사 기록으로 보존한다.

**새로 확인한 결함은 5개군(중간 3개·낮음 2개)이다.** 이 중 R2-01은 직전 옵션 복제 수정에서 발생한 회귀다. 기존 여섯 문제의 직접 재현을 막는 테스트는 통과하지만, JavaScript 객체 형태와 레거시 경계를 넓혀 검사하니 추가 우회가 발견됐다. 기존 미수정 F05·F07·F08·F10도 별도로 재확인했다.

현재 전체 테스트 **120개**, 실패 0개이며 타입 검사도 진단 없이 완료됐다. 추가로 결정적 생성 그래프 80개에서 경로 413개를 독립 계산과 비교해 탐색·압축 복원을 확인했다. 테스트 통과는 아래 결함이 없다는 뜻이 아니다.

## 검증한 구현과 범위

```text
package version: USL 0.3.0
sourceDigest: sha256:7bb9013df88514c18207f7d82fb70737bc767e3c2b0602d4be43a9ccfcea830a
scope: src/**/*.ts + package.json + package-lock.json + tsconfig.json, 23 files
algorithm: SHA-256(JSON.stringify(sorted [{file, digest}]))
per-file digest: SHA-256(exact file bytes)
```

[검토 시작 manifest](../audit/round2-source-manifest.json), [종료 시 일치·테스트 검증 기록](../audit/round2-verification.json). 직전 수정 기록과 비교하면 `src/project.ts`의 provenance 표기 수정이 이미 작업공간에 추가돼 있었고, 이를 포함한 현재 구현을 검사했다. 검토 중 23개 파일의 digest는 바뀌지 않았다. 제품 소스·기존 테스트는 수정하지 않았고 재현 자료와 이 보고서만 추가했다.

TypeScript + Effect CLI의 관측·JSON 검증·투영·레거시 수명주기·저장·조회 경계와 탐색·압축을 확인했다. 앞서 적용한 `security-best-practices` 검토 절차를 이어 사용했으며, 제공된 참조에는 이 Node CLI + Effect 조합에 직접 대응하는 가이드가 없어 판정은 코드 계약과 로컬 재현에 근거한다. 재현은 가짜 resolver, 임시 파일, 루프백 서버로 제한했다. 실제 KG 게시나 외부 시스템 침투는 하지 않았다. 등급은 제품의 무결성·조회 제약·운영 영향에 따른 우선순위이며 원격 공격의 CVSS 점수가 아니다.

## 중간 우선순위

### R2-01 — 클래스·비열거 옵션의 조회 제한이 사라진다 (회귀)

**위치:** [runtime.ts:42](/home/lagyeongjun/CD/USL/src/language/runtime.ts:42), [53](/home/lagyeongjun/CD/USL/src/language/runtime.ts:53), [67](/home/lagyeongjun/CD/USL/src/language/runtime.ts:67).

다음처럼 타입상 유효한 클래스 옵션을 전달한다.

```ts
class RestrictedOptions {
  get links() { return ["chosen"] }
  get allowedLocators() { return [] }
}
```

`structuredClone(options)`는 prototype getter를 보존하지 않아 `{}`가 된다. 실제 결과는 `chosen,ignored` 전체 링크 선택과 resolver **4회 호출**이었다. 자체 속성이어도 `enumerable: false`인 선택 조건은 사라진다. 반면 일반 JSON의 `null` 거부와 자체 열거 getter 1회 읽기는 정상 동작했다.

영향은 명시한 조회 제한을 기본값으로 넓혀 추가 자원을 읽는 것이다. 기본 CLI JSON 형태에서는 이 객체를 만들지 않지만, 정상적인 SDK 클래스 기반 설정으로 발생한다. 별도의 live resolver 상위 권한까지 우회한 것은 아니다. 직전에는 `options.links` 등을 직접 읽어 이 형태를 인식했으므로 이번 `structuredClone(options)` 도입의 회귀다.

**수정 방향:** 지원하는 옵션 필드 값을 각각 한 번 읽고, 그 값들로 일반 데이터 객체를 만든 뒤 검증·복제한다. 지원하지 않는 객체 형태라면 IO 전에 명시적으로 거부하며 기본값으로 바꾸지 않는다.

**증거:** [round2-semantics.ts](../audit/round2-semantics.ts), [결과](../audit/round2-semantics-results.json)의 `prototype_option_loss`, `nonenumerable_option_loss`.

### R2-02 — 같은 URL을 두 번 읽고 자원 예산도 중복 계산한다

**위치:** [runtime.ts:61](/home/lagyeongjun/CD/USL/src/language/runtime.ts:61), [66](/home/lagyeongjun/CD/USL/src/language/runtime.ts:66), [69](/home/lagyeongjun/CD/USL/src/language/runtime.ts:69).

유효한 `.usl`의 두 참여 자원에 `https://example.test`와 `https://example.test/`를 선언한다. 허용 정책의 `locatorKey`는 같은 URL로 정규화하지만 조회 대상 Map은 원래 문자열로 구분한다. KG grounding 한 개를 포함한 결과는 `uniqueLocators: 3`, URL 조회 2회와 KG 조회 1회다. 예산을 2로 주면 읽기 전에 예산 초과로 거부된다.

정규화된 조회 정체성은 URL과 KG 두 개다. 동일 엔드포인트를 중복 읽어 IO 비용과 예산 소모가 늘며 필요한 작업이 잘못 거부된다. AI 토큰 절감률 자체를 측정한 결과는 아니지만, 선택 조회·중복 제거를 통한 비용 절감에 직접 영향을 준다. 기존부터 있던 불일치이며 이번에 처음 재현했다.

**수정 방향:** 조회 중복 제거·예산·실제 호출은 같은 정규화 키를 사용한다. 원래 선언 주소와 별칭은 보고서에서 보존하고, 별칭별 관측을 동일한 수집 결과에 연결한다. 통계·검증기의 중복 정의도 함께 맞춘다.

**증거:** [semantic 결과](../audit/round2-semantics-results.json)의 `url_canonical_alias_double_read`.

### R2-03 — 레거시 JSON은 다른 KG UID의 결과를 확정 등급으로 받는다

**위치:** [validation.ts:35](/home/lagyeongjun/CD/USL/src/validation.ts:35), [project.ts:58](/home/lagyeongjun/CD/USL/src/project.ts:58).

요청을 `kg://canonical-neo4j/sym:Concept:original`, `resolved_locator_from`을 `kg://canonical-neo4j/sym:Concept:substituted`로 작성하고 나머지 기준 필드를 채운 레거시 JSON을 입력한다. 검증과 투영이 성공하며 **`CANONICAL`, `review_required: false`**가 나온다.

새 검사는 주소 문법과 종류까지 확인하지만 KG source/UID 동일성을 확인하지 않는다. 관측 v2의 F09 수정은 정상 동작하며, 이 문제는 별도의 레거시 JSON 경로에 남은 동일성 누락이다. 실제 resolver는 다른 UID를 정상 결과로 인정하지 않는다. 실험은 번들 생성까지이며 KG 게시를 수행하지 않았다.

**수정 방향:** 레거시의 확정 관측도 요청한 KG source/UID와 결과가 같아야 한다. 이동·alias가 필요하다면 먼저 그 근거를 명시하는 계약을 정의한다. 재조회한 `audit`는 이 변조를 `DRIFT/LabelRot`으로 잡았고 `rebind`는 정상 기준으로 교체했다.

**증거:** [round2-legacy.ts](../audit/round2-legacy.ts), [결과](../audit/round2-legacy-results.json)의 `L2-01`, `L2-D01`, `L2-D02`.

## 낮은 우선순위

### R2-04 — 검증한 사본을 버려 getter가 확정 상태를 바꿀 수 있다

**위치:** [project.ts:29](/home/lagyeongjun/CD/USL/src/project.ts:29), [43](/home/lagyeongjun/CD/USL/src/project.ts:43).

근거가 불완전한 객체의 `status` getter가 최초에는 `DRIFT`, 이후에는 `RESOLVES`를 반환하도록 한다. `toBundle`은 `validateRecords`가 반환한 검증된 데이터를 사용하지 않고 원래 객체를 다시 읽는다. 그 결과 불완전한 근거와 `RESOLVES / CANONICAL / review_required: false`가 함께 투영됐다.

같은 프로세스의 accessor 객체가 필요하며 `JSON.parse` 입력에는 getter가 없다. 일반 JSON의 누락 근거 거부는 정상이다. **수정 방향:** 반환받은 검증 사본만으로 투영하고, 검증과 사용 사이에서 원본 객체를 다시 읽지 않는다.

**증거:** [legacy 결과](../audit/round2-legacy-results.json)의 `L2-03-in-memory-status-getter-time-of-check-time-of-use`.

### R2-05 — 잘못된 resolver 실패 객체로 자기 검증에 실패하는 보고서를 만든다

**위치:** [runtime.ts:79](/home/lagyeongjun/CD/USL/src/language/runtime.ts:79), [102](/home/lagyeongjun/CD/USL/src/language/runtime.ts:102).

사용자 정의 adapter가 실패값의 `reason`에 `NOT_A_REASON`을 전달하면 관측 함수는 완료되지만 그 결과를 `validateObservation`에 넣으면 거부된다. 성공 응답에는 schema 검사가 추가됐으나 실패 응답은 필드를 그대로 복사한다.

adapter가 선언된 `ResolveError` 계약을 위반해야 하므로 낮은 우선순위의 SDK 견고성 문제다. 기본 resolver의 정상 실패 응답에서 재현되는 문제는 아니다. **수정 방향:** 실패 결과의 종류·필드도 복사 시 검증하고, 잘못된 adapter 응답은 도메인 오류로 종료한다.

**증거:** [semantic 결과](../audit/round2-semantics-results.json)의 `malformed_resolver_failure_emits_invalid_report`.

## 기존 문제의 재확인 — 새 결함 수에 포함하지 않음

| 최초 ID | 이번 결과 | 조건·근거 |
| --- | --- | --- |
| F05 | 사용자 정의 resolver의 `matchCount: 2`가 레거시 `RESOLVES`가 됨 | [legacy 결과](../audit/round2-legacy-results.json), 기본 KG resolver는 다중 일치를 별도로 거부 |
| F07 | query getter가 보고된 방향·시작점과 실제 경로를 다르게 만듦 | [context 재실행 결과](../audit/round2-known-context-results.json), 같은 프로세스 JavaScript getter 필요 |
| F08 | MCP 307이 다른 루프백 서버로 요청을 전달함 | [IO 결과](../audit/round2-io-results.json), 설정한 MCP 서버가 redirect할 때 발생. 논리 KG 권한과 transport URL 정책은 별개 |
| F10 | 직접 `resolveWith(...)(null)` 및 중첩 plan의 `participants: null`에서 TypeError | [IO](../audit/round2-io-results.json), [semantic](../audit/round2-semantics-results.json) 결과. 잘못된 SDK 입력 조건 |

이 네 항목은 직전 여섯 수정의 범위 밖이거나 일부만 보완됐다고 이미 기록한 내용이다.

## 통과한 방어와 검증의 한계

- 기존 여섯 수정의 회귀 테스트는 통과했다. 자체 속성의 `null` 옵션은 IO 전에 거부됐고, resolver가 보관한 성공 객체와 요청·정책 사본 변경은 관측에 영향을 주지 않았다. 의미를 반대로 바꾼 원문 투영과 관측 v2 KG identity 변조도 거부됐다.
- F06은 세 입력의 직접·symlink 별칭 외에 symlink 부모 디렉터리와 symlink 입력까지 거부했다. 원본 파일은 보존됐고 별도 출력은 성공했다. hardlink 출력은 거부되지 않지만 atomic rename이 출력 항목만 교체해 입력은 보존됐다. 입력 덮어쓰기 취약점으로 세지 않았다. [IO 결과](../audit/round2-io-results.json)
- 고정 seed `20260908`로 생성한 **80개**의 3항 링크 그래프에서 별도의 방향 그래프 BFS와 도달 거리·목적지 존재를 대조했다. **413개 경로**의 압축 tuple 복원, 선언 보존, byte 예산 거부, 정확한 cache 재사용이 통과했다. [재현](../audit/round2-context.ts), [결과](../audit/round2-context-results.json)
- `content_hash`의 SHA 형식이 강제되지 않는 현상은 이번 새 중간 결함에서 제외했다. 현재 schema는 문자열을 받는다. 형식 강화의 검토 여지는 있지만 올바른 64자리 값도 조작할 수 있어, 형식 검사와 근거·작성자 인증을 혼동하지 않는다.
- 실제 게임 개발에서 모델에 청구된 토큰·사람의 탐색 시간·장기 오탐률은 측정하지 않았다. CPU 전처리 상한, 서명 없는 출처 인증, 모든 FS 경쟁 조건, dependency CVE 및 모든 입력의 전수 검증을 보장하지 않는다.

## 재현

저장소 루트에서 실행한다. 감사 probe의 성공 종료는 해당 실험이 완료됐다는 뜻이며, 결함이 없다는 뜻은 아니다. 결과 JSON의 판정을 확인한다. Probe는 `tsconfig`의 `src`/`test` 범위 밖에서 `tsx`로 실행했다.

```sh
npm run typecheck
npm test
node --import tsx audit/round2-semantics.ts
node --import tsx audit/round2-legacy.ts
node --import tsx audit/round2-io.ts
node --import tsx audit/round2-context.ts
node --import tsx audit/context-probes.ts > audit/round2-known-context-results.json
```

후속 수정은 R2-01 회귀 차단을 먼저 하고, R2-03의 레거시 동일성 검사와 R2-02 중복 조회를 처리하는 순서가 적절하다. 이번 작업은 재검증과 보고이며 이 다섯 항목의 제품 코드 수정은 아직 적용하지 않았다.
