# USL 적대적 검증 — 2026-09-08

후속 수정: 사용자가 지정한 **F01·F02·F03·F04·F06·F09를 수정했다.** [수정 내용과 검증](ADVERSARIAL_FIXES_2026-09-08.md)을 참조한다. 아래 판정·digest·probe 결과는 수정 전 구현의 감사 기록으로 보존한다.

## 판정과 검증 대상

**재현된 결함은 원인별 10개군이다. 우선순위 높음 2개, 중간 7개, 낮음 1개다.** 기존 타입 검사와 테스트 106개는 통과했지만, 추가한 공격 입력에서 조회 범위 확대, 관측 객체 오염, 잘못된 출처 귀속, 불완전한 근거의 확정 등급 투영, 입력 파일 덮어쓰기를 확인했다.

여기서 등급은 USL의 관측 신뢰성·조회 제약·데이터 보존에 대한 수정 우선순위다. 원격 공격 가능성을 나타내는 CVSS 점수가 아니다. 사용자 정의 resolver나 JavaScript getter가 필요한 경우는 아래에 명시했다. 기본 CLI와 기본 resolver만으로 모든 문제가 발생하는 것은 아니다.

검증한 구현은 `package.json` 기준 **USL 0.3.0**이다. 버전 문자열만으로 구현을 식별하지 않도록, `src/**/*.ts`와 `package.json`, `package-lock.json`, `tsconfig.json` 총 23개 파일을 고정했다.

```text
sourceDigest: sha256:532b4973de386be90efed52e0294bbf88bfb3a8b6a2170387644a2d7bad1ac2c
capturedAt: 2026-09-08T03:35:22.267Z
digest algorithm: SHA-256(JSON.stringify(sorted [{file, digest}]))
per-file digest: SHA-256(exact file bytes)
```

[원본 파일별 manifest](../audit/source-manifest.json), [검토 종료 시 일치 검사](../audit/source-verification.json). 이 digest는 **검토한 구현**의 식별자다. 개별 관측의 `planDigest`·`meaningsDigest`·`sourceDigest`와 구별한다. 재현에 쓴 의미 정의와 plan 생성 과정은 각 probe 소스에 포함돼 있다.

범위는 parser/compiler, 의미 계약·digest, 관측·비교·JSON 검증, 탐색·압축·캐시, FS/Git/URL/KG resolver, 레거시 pierce/audit/rebind, 저장·CLI·KG 번들 생성과 관련 문서다. 소스 검토와 기존 테스트를 바탕으로, 취약한 경계에는 별도의 재현 probe를 실행했다. 모든 기능에 모든 공격 입력을 대입했다는 뜻은 아니다.

`security-best-practices` skill의 검토·우선순위 보고 절차를 적용했다. 제공된 참조 중 Node CLI + Effect에 직접 대응하는 가이드는 없어, 개별 판정은 저장소의 계약·구현·재현 결과를 근거로 했다. 실험은 임시 파일, 가짜 resolver/fetch, 루프백 HTTP 서버에서 수행했다. 실제 KG에 쓰거나 외부 서비스를 공격하지 않았다. 운영 소스·기존 테스트는 수정하지 않았으며 `audit/` 재현 자료와 이 보고서를 추가했다.

## 결함 목록

| ID | 우선순위 | 결함 | 발생 경로 |
| --- | --- | --- | --- |
| F01 | 높음 | 명시적 `null`을 생략으로 취급해 조회 선택·권한·예산을 기본값으로 확대 | JS SDK / JSON 옵션 연결 |
| F02 | 높음 | resolver 소유 객체 변경이 수집 중·반환 후 관측에 반영 | 객체를 재사용하는 사용자 정의 resolver |
| F03 | 중간 | 의미 A를 반대 의미 B 원문의 digest에 귀속 | `toSemanticBundle` SDK |
| F04 | 중간 | 근거 없는 `RESOLVES` 레코드가 `CANONICAL`로 투영 | 레거시 JSON import / project |
| F05 | 중간 | `matchCount: 2`가 성공 및 rebind 기준으로 수용 | 사용자 정의 resolver + 레거시 API |
| F06 | 중간 | 출력 경로가 원문·anchor 입력 파일을 덮어씀 | 레거시 `project` CLI |
| F07 | 중간 | query getter 변경으로 보고한 방향·시작점과 실제 경로가 불일치 | JavaScript SDK |
| F08 | 중간 | KG MCP HTTP redirect가 다른 서버에 요청을 전달 | 기본 fetch + redirect하는 MCP 서버 |
| F09 | 중간 | 다른 KG 정체성을 가리키는 `resolvedLocator` 변조가 검증 통과 | 관측 JSON import |
| F10 | 낮음 | 잘못된 전체 API 인자가 명시된 오류 대신 TypeError를 발생 | JS SDK의 잘못된 인자 |

### F01 — 명시적 null이 조회 범위를 확대한다

- **위치:** [runtime.ts:43](/home/lagyeongjun/CD/USL/src/language/runtime.ts:43), [54](/home/lagyeongjun/CD/USL/src/language/runtime.ts:54), [57](/home/lagyeongjun/CD/USL/src/language/runtime.ts:57).
- **재현:** 두 링크가 있는 plan에 `{ links: null }`을 전달하면 오류 없이 두 링크 모두 선택하고 resolver를 4회 호출한다. `{ allowedLocators: null }`은 선택 자원 전체를 허용해 3회 호출한다. `{ maxResources: null }`은 예산 256으로 실행된다.
- **원인·영향:** `??`가 유효한 생략값 `undefined`와 잘못된 명시 입력 `null`을 합친다. 타입이 보장되지 않는 JSON 옵션을 연결하는 호출자는 입력 오류를 발견하지 못하고 의도보다 넓게 읽거나 비용을 지출할 수 있다. 별도로 설정된 live resolver 권한까지 우회한다는 결과는 아니다. `allowedLocators: []`는 정상적으로 모든 읽기를 차단한다.
- **권장 수정:** 전체 options 형태를 검사하고, 기본값은 `undefined`일 때만 적용한다. `null`을 포함한 잘못된 선택·권한·예산은 IO 전에 `ObservationError`로 종료한다.
- **근거:** [semantic probe](../audit/semantic-probes.ts), [결과](../audit/semantic-results.json)의 `null_links_defaults_to_all`, `null_allowed_locators_defaults`, `null_resource_budget_defaults`.

### F02 — 수집한 Resolution이 resolver와 같은 객체다

- **위치:** [runtime.ts:63](/home/lagyeongjun/CD/USL/src/language/runtime.ts:63), [71](/home/lagyeongjun/CD/USL/src/language/runtime.ts:71).
- **재현:** 자원 `a`의 resolver가 객체를 반환한 뒤, grounding resolver가 그 객체의 `contentHash`를 바꾼다. 최종 보고서에는 바뀐 hash가 들어간다. 보고서 반환 후에도 resolver가 보관한 객체를 바꾸면 보고서가 바뀌고 기존 `observationDigest` 검증은 실패한다.
- **원인·영향:** plan은 복제하지만 개별 성공 응답은 참조로 보관한다. 캐시 객체를 재사용하는 adapter만으로도 이미 수집한 근거의 시점이 섞인다. 기본 live resolver는 새 객체를 만들며, 이 실험은 사용자 정의 `Resolvers` 확장 경로의 소유권 문제를 입증한다. 악성 adapter의 거짓 응답 자체를 막을 수 있다는 뜻은 아니다.
- **권장 수정:** 각 resolver 성공 직후, 다른 응답을 기다리기 전에 응답을 검증·깊은 복제한다. 전달하는 locator도 내부 plan과 분리해 adapter가 선언을 수정할 수 없도록 하고, 반환 보고서가 adapter 소유 객체를 참조하지 않게 한다.
- **근거:** [semantic probe](../audit/semantic-probes.ts), [결과](../audit/semantic-results.json)의 `mutable_resolver_result_before_assembly`, `mutable_resolver_result_after_return`.

### F03 — 투영에서 반대 의미의 원문을 출처로 붙일 수 있다

- **위치:** [language/project.ts:30](/home/lagyeongjun/CD/USL/src/language/project.ts:30), [51](/home/lagyeongjun/CD/USL/src/language/project.ts:51).
- **재현:** plan A의 의미는 `A implements B`, `options.source.text` B의 의미는 `A contradicts B`로 전달한다. 함수는 성공하며, 출력은 A의 설명과 B 원문의 `source_sha256`을 함께 포함한다.
- **원인·영향:** 원문을 hash할 뿐 해당 원문이 plan으로 컴파일되는지 확인하지 않는다. 관측 경로에서 막은 출처 혼합이 KG 번들 생성 API에 남아 있다. 현재 CLI는 같은 원문을 컴파일해 전달하므로 재현은 SDK 경로다. 번들은 `PENDING_OR_PRELIMINARY` 상태이고 실제 KG 게시를 수행하지 않는다.
- **권장 수정:** 원문이 제공되면 컴파일한 plan digest를 입력 plan digest와 대조한 후 투영한다. 원문과 plan은 한 번 읽은 값으로 고정한다.
- **근거:** [storage/projection probe](../audit/storage-projection-probes.ts), [결과](../audit/storage-projection-results.json)의 `projection-source-mismatch`.

### F04 — 불완전한 레코드가 검증을 통과해 확정 등급을 받는다

- **위치:** [validation.ts:5](/home/lagyeongjun/CD/USL/src/validation.ts:5), [project.ts:58](/home/lagyeongjun/CD/USL/src/project.ts:58).
- **재현:** 양 끝의 hash·resolved locator·관측 시각이 모두 `null`인 레코드에 `status: "RESOLVES"`, `confidence: "EXTRACTED"`를 준다. `validateRecords`가 수용하고 `toBundle`은 `canonical_scope: "CANONICAL"`, `review_required: false`를 생성한다.
- **원인·영향:** 레거시 검증은 타입·ID 중복·요청 locator를 검사하지만 상태와 근거의 내부 일관성을 검사하지 않는다. 투영은 검증된 것으로 간주한 상태를 그대로 등급으로 바꿔, 관측 근거가 없는 입력을 확정된 것으로 표시한다. 확인한 것은 번들 생성이며 실제 KG 반영은 아니다.
- **권장 수정:** `RESOLVES`에 필요한 양 끝의 완전한 관측값과 상태 간 불변식을 검증한다. 기존 결측 레코드를 읽어야 한다면 별도의 미확정 상태로 이행하고, 등급 산정에도 완전성 조건을 둔다.
- **근거:** [storage/projection 결과](../audit/storage-projection-results.json)의 `legacy-unresolved-record-canonical`.

### F05 — 레거시 API가 여러 일치를 단일 성공으로 처리한다

- **위치:** [pierce.ts:27](/home/lagyeongjun/CD/USL/src/pierce.ts:27), [91](/home/lagyeongjun/CD/USL/src/pierce.ts:91), [129](/home/lagyeongjun/CD/USL/src/pierce.ts:129).
- **재현:** 타입상 유효한 `Resolution`에 `matchCount: 2`를 넣어 양 끝에서 성공 응답한다. `pierce`와 `audit`는 `RESOLVES`, `rebind`는 성공을 반환한다.
- **원인·영향:** `endStatus`는 성공 Either이면 일치 수와 무관하게 `OK`로 만든다. 새 관측 경로와 달리 레거시 경로는 비유일한 대상을 기준 관측으로 확정할 수 있다. 기본 KG resolver는 자체적으로 다중 일치를 거부하므로 사용자 정의 resolver가 필요한 재현이다.
- **권장 수정:** 성공 응답도 `matchCount === 1`을 검사하는 공통 경계를 사용한다. 비유일한 응답은 확정·rebind 기준이 되지 않아야 한다.
- **근거:** [storage/projection 결과](../audit/storage-projection-results.json)의 `legacy-multiple-matches-resolve`.

### F06 — 레거시 project가 원문·anchor 입력을 덮어쓴다

- **위치:** [cli.ts:162](/home/lagyeongjun/CD/USL/src/cli.ts:162).
- **재현:** `project --records records.json --utterance-file request.txt --out request.txt ...`를 임시 파일로 실행한다. 종료 코드 0으로 원문이 번들 JSON으로 교체된다. `--out`을 `--anchors` 파일로 지정해도 동일하다.
- **원인·영향:** 출력 경로 충돌 검사는 `--records`에만 적용된다. 충돌하는 플래그를 전달하면 실제 원문·매핑 데이터가 소실된다. 언어 소스 경로에 있는 입력 보호와 레거시 경로의 동작이 다르다.
- **권장 수정:** 모든 입력 파일과 출력의 정규화·realpath 기반 충돌 검사를 공유하고 쓰기 전에 거부한다.
- **근거:** [storage/projection probe](../audit/storage-projection-probes.ts), [결과](../audit/storage-projection-results.json)의 `legacy-project-overwrites-utterance`, `legacy-project-overwrites-anchors`. 임시 파일 외에는 변경하지 않았다.

### F07 — 탐색 결과가 실제 사용한 query를 다르게 보고한다

- **위치:** [navigation.ts:100](/home/lagyeongjun/CD/USL/src/language/navigation.ts:100), [127](/home/lagyeongjun/CD/USL/src/language/navigation.ts:127), [171](/home/lagyeongjun/CD/USL/src/language/navigation.ts:171).
- **재현:** `routes` getter가 호출 횟수에 따라 값을 바꾸게 한다. 보고서의 허용 방향은 `right → left`인데 경로는 `left → right`다. 별도 `focus` getter 실험에서는 보고한 시작점이 `b`, 0단계 경로의 자원이 `a`다.
- **원인·영향:** 검증·탐색·출력 때 query를 반복해서 읽는다. AI에 전달하는 경로 설명이 실제 탐색 조건과 불일치할 수 있다. 동기 함수에 사용자 정의 getter를 전달해야 하며 일반 JSON에는 getter가 없다. 파일·네트워크 접근 권한 우회는 입증하지 않았다.
- **권장 수정:** 진입 시 query 필드와 route 원소의 값을 각각 한 번 읽어 일반 데이터로 고정하고, 검증부터 출력까지 그 사본을 사용한다.
- **근거:** [context probe](../audit/context-probes.ts), [결과](../audit/context-results.json)의 `routeSwitch`, `focusSwitch`.

### F08 — KG MCP transport가 redirect를 자동 추적한다

- **위치:** [resolve.ts:194](/home/lagyeongjun/CD/USL/src/resolve.ts:194), [197](/home/lagyeongjun/CD/USL/src/resolve.ts:197).
- **재현:** 등록한 루프백 MCP 서버가 다른 루프백 서버로 HTTP 307을 반환한다. 기본 fetch가 두 번째 서버에 `POST ontology_get`과 원래 UID를 전달하고 관측은 성공한다.
- **원인·영향:** URL resolver와 달리 KG fetch는 redirect 정책을 지정하지 않는다. 배포 환경이 설정된 MCP 주소를 네트워크 신뢰 경계로 삼는다면 요청 정보가 그 경계 밖으로 전달될 수 있다. 현재 `allowedLocators`는 논리적인 `kg://source/uid` 권한이며 MCP transport URL의 allowlist가 아니다. 따라서 기존 transport allowlist를 우회했다고 표현하지 않는다.
- **권장 수정:** MCP transport redirect를 거부하거나, 별도의 endpoint 정책으로 각 hop을 허용한 뒤 전송한다. 논리 KG locator 권한과 transport 권한을 구분한다.
- **근거:** [IO probe](../audit/io-probes.ts), [결과](../audit/io-results.json)의 `IO-01-mcp-redirect-forwards-request-to-unregistered-transport`.

### F09 — 관측 검증이 KG resolved identity 변경을 놓친다

- **위치:** [comparison.ts:57](/home/lagyeongjun/CD/USL/src/language/comparison.ts:57). 기본 resolver의 대조 조건은 [resolve.ts:212](/home/lagyeongjun/CD/USL/src/resolve.ts:212).
- **재현:** 유효한 관측 JSON에서 grounding의 `resolution.resolvedLocator`만 다른 KG source/UID로 바꾸고 바깥 `observationDigest`를 다시 계산한다. 요청 locator는 원래 값인데 검증이 성공한다.
- **원인·영향:** 검증기는 요청 locator 및 resolved kind를 검사하지만 KG의 resolved identity 동일성은 검사하지 않는다. 기본 KG resolver가 생성하지 않는 내부 불일치를 imported 보고서에서는 수용한다. 이것은 서명 없는 보고서 전체의 진위 문제와 구별되는 내부 일관성 누락이다.
- **권장 수정:** 현재 계약에서는 KG source/UID 동일성을 요구한다. 추후 KG 이동을 지원하려면 명시적인 alias/relocation 근거 계약을 먼저 정의한다.
- **근거:** [semantic 결과](../audit/semantic-results.json)의 `forged_kg_redirect`.

### F10 — 잘못된 전체 API 인자가 타입 오류 경계를 벗어난다

- **위치:** [resolve.ts:221](/home/lagyeongjun/CD/USL/src/resolve.ts:221), [runtime.ts:35](/home/lagyeongjun/CD/USL/src/language/runtime.ts:35).
- **재현:** `resolveWith(cfg)(null)`은 동기 TypeError를 던진다. `observeProgram(null)`과 `observeProgram(plan, null)`은 `ObservationError` 대신 TypeError 기반 FiberFailure로 끝난다.
- **영향·권장 수정:** 잘못된 JS 입력이 호출자의 선언된 오류 처리 경계를 벗어난다. CLI의 정상 파싱 경로에서는 이 입력이 직접 생성되지 않는다. 전체 인자를 역참조하기 전에 검사하고 명시적인 도메인 오류를 반환한다.
- **근거:** [IO 결과](../audit/io-results.json)의 `IO-02-malformed-runtime-locator-throws`, [semantic 결과](../audit/semantic-results.json)의 `null_observe_plan`, `null_observe_options`.

## 방어가 확인된 항목

- 관측 도중 `sourceText` 옵션을 수정·삭제해도 시작 시 원문의 digest가 유지됐다. 앞서 지적된 원문 혼합 문제의 **관측 경로** 수정은 동작한다. F03은 별도 투영 경로다.
- 기존 관측 검증 테스트에서 `EXECUTED` 조작, 잘못된 필드 타입·조회 범위·통계를 넣고 바깥 digest를 재계산한 변조를 거부했다. F09는 그 외 KG identity의 누락이다.
- 정상 선택에서는 선택한 링크의 참여자·grounding만 읽고, 빈 allowlist에서는 resolver 호출이 0회였다.
- 같은 KG 내용에서 의미 설명을 뒤집으면 의미 계약 변경으로, 주소만 바꾸면 주소 연결 변경으로 분리됐다.
- URL redirect의 비허용 목적지는 두 번째 요청 전에 차단됐다. 정적 FS symlink도 실제 경로 권한이 없으면 거부됐다.
- 저장 시 오래된 snapshot과 직접 symlink 출력이 차단됐고 대상 파일은 보존됐다.
- 압축 컨텍스트의 정확히 일치하는 캐시는 `UNCHANGED` 238 bytes를 반환했다. 토큰 예산 초과는 거부됐으며 기존 테스트의 byte/token 예산 및 계약·역할·경로 보존 검사도 통과했다.

## 결함과 구별한 한계

1. **digest는 출처 인증이 아니다.** 원문·전체 plan 또는 신뢰한 외부 기준 없이 선택 관측 JSON만으로 `planDigest`, `meaningsDigest`, `sourceDigest`의 진위를 독립 검증할 수 없다. 모든 값을 일관되게 다시 작성하는 공격은 현재 서명 없는 형식의 한계다. 전체 선언 수 역시 선택 자료만으로 정확히 재계산할 수 없다.
2. **0개 일치를 AMBIGUOUS로 처리하는 것은 현재의 보수적 정책이다.** `matchCount !== 1`을 미확정으로 보는 것이며, 성공으로 오인하지 않아 별도 결함으로 세지 않았다.
3. **탐색 예산은 전체 CPU 예산이 아니다.** 5,000개 링크에 `maxVisits: 1`을 주면 visits는 1이지만 전체 plan의 incidence index 구축은 선행한다. 해당 실험은 약 11.92ms였으며 일반적인 성능 보장이 아니다. 문서화된 선형 전처리 비용으로 분류했다.
4. **캐시·토큰 절감의 범위가 한정된다.** `UNCHANGED`는 정의·query의 동일성을 뜻하며 외부 코드 내용의 최신성을 증명하지 않는다. 238 bytes는 응답 크기이며 실제 모델 과금 토큰 수가 아니다. tokenizer callback의 측정값도 선택한 tokenizer 기준이다. 게임 개발 업무에서 참조 탐색 시간·오래된 근거 적발·불필요 재검사·실제 토큰 절감을 비교한 실사용 실험은 이번 감사에 포함하지 않았다.
5. **프로세스 내부와 호스트를 신뢰하는 경계가 남는다.** 실행 중 `ResolverConfig` 변경은 응답 제한에 영향을 줄 수 있다. 이 API는 설정 snapshot이나 샌드박스를 약속하지 않는다. FS symlink 검사 성공이 모든 TOCTOU 경쟁 조건에 대한 증명은 아니다.
6. dependency CVE 스캔, 실제 운영 KG/저장소에 대한 침투, 형식 검증, 가능한 모든 입력의 전수 fuzzing은 수행하지 않았다.

## 재현과 수정 순서

저장소 루트에서 실행한다. probe는 **취약점 재현 도구**이며, 종료 코드 0은 취약점이 없다는 뜻이 아니다. JSON의 `FINDING`/`CONFIRMED` 또는 불일치 필드를 확인한다. `RESISTED`는 해당 공격을 막았다는 뜻이고, `LIMITATION`은 계약상 한계다. 소스 변경 이후 결과는 달라질 수 있다.

```sh
npm run typecheck
npm test
node --import tsx audit/verify-source.ts
node --import tsx audit/semantic-probes.ts
node --import tsx audit/io-probes.ts
node --import tsx audit/context-probes.ts > audit/context-results.json
node --import tsx audit/storage-projection-probes.ts
```

`verify-source.ts`는 원본 manifest를 보존하고 현재 파일과 비교한다. `capture-source.ts`는 manifest를 새로 만드는 도구이므로 기존 감사의 동일성 확인 용도로 다시 실행하지 않는다. Probe 파일은 현재 `tsconfig`의 `src`/`test` 검사 대상 밖에 있고 `tsx`로 실행했다.

권장 수정 순서는 **F01·F02 → F03·F04·F06 → F05·F07·F08·F09 → F10**이다. 각 수정은 위 재현을 실패를 검출하는 회귀 테스트로 옮겨 확인한다. 이번 작업은 검증과 보고까지이며, 발견한 결함의 운영 코드 수정은 아직 적용하지 않았다.
