# 적대적 검증 후속 수정 — 2026-09-08

사용자가 지정한 여섯 문제 F01·F02·F03·F04·F06·F09의 수정과 회귀 테스트를 적용했다. [최초 감사](ADVERSARIAL_REVIEW_2026-09-08.md)의 원본 manifest와 probe 결과는 덮어쓰지 않았다. 수정한 구현의 digest와 최종 검사 결과는 [수정 검증 기록](../audit/remediation-verification.json)에 별도로 남겼다.

| 항목 | 변경된 동작 | 회귀 검증 |
| --- | --- | --- |
| F01 조회 옵션 | `null` 선택·허용 목록·자원 예산은 기본값을 적용하지 않고 IO 전에 `ObservationError`로 거부한다. | [observation-boundaries.test.ts](../test/observation-boundaries.test.ts): 실패와 resolver 호출 0회 확인 |
| F02 관측 객체 | 호출 옵션·요청 locator·정책을 분리하고, 각 완료 응답을 즉시 복제·검증한다. 다음 resolver의 함수 호출도 Effect 실행까지 지연한다. | 같은 파일: 다음 resolver와 반환 후 보관 객체 변경에도 관측값·digest·scope 보존 |
| F03 원문 귀속 | 원문을 한 번 읽어 고정한 후 컴파일한 plan digest와 입력 plan snapshot을 대조한다. 불일치 시 번들을 만들지 않는다. | [semantic-projection-validation.test.ts](../test/semantic-projection-validation.test.ts): 반대 의미 거부, getter 변경 차단, 정상·원문 생략 호환 |
| F04 확정 등급 | `RESOLVES`는 양 끝의 비어 있지 않은 hash·resolved locator·시각, 유효한 resolved locator 형식·종류, `EXTRACTED`, drift score 0을 요구한다. 투영 전에 검증한다. | [record-validation.test.ts](../test/record-validation.test.ts): 불완전·모순 레코드와 잘못된 주소 거부, 미확정 상태 유지 |
| F06 입력 보호 | 레거시 project도 records·원문·anchors와 출력 경로의 realpath 충돌을 모두 거부한다. 소스 project와 검사 함수를 공유한다. | [cli-project-inputs.test.ts](../test/cli-project-inputs.test.ts): 세 입력의 직접·symlink 별칭 거부와 원본 보존, 별도 출력 성공 |
| F09 KG identity | 관측 생성과 JSON 검증 모두 KG 결과의 source/UID가 요청 identity와 같은지 확인한다. | [observation-boundaries.test.ts](../test/observation-boundaries.test.ts): 다른 UID/source를 허용 목록에도 넣고 외부 digest를 재계산해도 거부 |

레거시 검증 강화에 맞춰, 기존 기준이 있는 레코드가 일시적 IO·ORPHAN에서 정상으로 복구되면 `audit`가 `EXTRACTED` 신뢰도를 회복하게 했다. [pierce.test.ts](../test/pierce.test.ts)는 복구 결과가 저장 검증을 통과하는지 확인한다. 미확정 상태의 불완전한 기준은 계속 읽을 수 있으며 명시적인 rebind로 복구할 수 있다.

최종 `npm run typecheck`와 `npm test`가 모두 통과했다. 전체 **119개**, 실패 0개이며 최초 감사의 106개에서 회귀 테스트 13개가 늘었다. 핵심 관측 경계의 새 테스트 네 개는 수정 전 실패하는 것을 먼저 확인했다. 테스트는 가짜 resolver와 임시 파일·서버를 사용하며 실제 KG에 쓰지 않는다. 기존 audit probe는 수정 전 취약점을 재현하기 위한 스크립트여서 수정 후 입력 거부 시 일찍 종료할 수 있다. 후속 성공 여부는 위 회귀 테스트를 기준으로 확인한다.

호환성 변경: 불완전하거나 모순된 `RESOLVES` JSON은 이제 읽기·저장·투영에서 거부된다. 레거시 시각 필드는 비어 있지 않은지만 확인하며 ISO 형식으로 강제 이행하지 않는다. digest는 계속 데이터 식별 수단이며 근거의 사실성이나 작성자 인증을 증명하지 않는다.

최초 감사의 나머지 F05(레거시 다중 일치), F07(query getter), F08(MCP transport redirect)는 이번 여섯 항목에 포함되지 않는다. F10은 관측 인자 검사가 일부 보완됐지만 `resolveWith`의 잘못된 전체 인자 처리는 남아 있다. 원본 감사 전체가 해결됐다고 판정하지 않는다.
