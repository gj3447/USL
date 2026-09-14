# 2차 적대적 검증 후속 수정 — 2026-09-08

사용자가 요청한 R2-01~R2-05 다섯 항목을 보완했다. [2차 감사](ADVERSARIAL_REVIEW_ROUND2_2026-09-08.md)의 원본 소스 manifest·결과는 보존했고, 수정된 구현과 회귀 테스트는 [별도 검증 기록](../audit/round2-fixes-verification.json)에 식별한다.

| 항목 | 보완 | 회귀 테스트 |
| --- | --- | --- |
| R2-01 옵션 제한 소실 | 알려진 필드를 한 번씩 직접 읽는다. 클래스·prototype·비열거 옵션을 적용하고, 배열은 다음 getter 실행 전에 복제한다. | [observation-options-errors.test.ts](../test/observation-options-errors.test.ts): 상속·숨긴 속성·교차 getter 변경·deny-all·0 예산·null |
| R2-02 URL 중복 조회 | `locatorKey`로 대상·결과를 묶고 첫 선언을 대표 요청으로 사용한다. 원래 별칭은 자원에 남기며 예산·통계·검증을 같은 기준으로 계산한다. | [observation-url-aliases.test.ts](../test/observation-url-aliases.test.ts): 선언 순서 반전, 2개 예산에 URL+KG 조회, 거부 수, 상충하는 hash/시각·위조 통계 차단 |
| R2-03 레거시 KG identity | `RESOLVES`의 양 끝 KG 결과는 요청 source·UID를 유지해야 한다. | [record-validation.test.ts](../test/record-validation.test.ts): 양 끝 UID/source 변조 거부, 정상 URL 이동·과거 DRIFT 호환 |
| R2-04 검증 이후 getter 변경 | `toBundle`은 `validateRecords`가 반환한 사본만 사용한다. | 같은 파일: status getter가 나중에 확정 상태를 반환해도 미확정 투영, 옵션 getter가 원본을 수정해도 검증 사본 유지 |
| R2-05 잘못된 실패 응답 | 실패 metadata도 필드와 요청 identity를 검사한 뒤 복사한다. 잘못된 adapter 응답은 보고서 대신 `ObservationError`로 종료한다. | [observation-options-errors.test.ts](../test/observation-options-errors.test.ts): 한 번에 한 필드만 변조하여 reason·kind·locator·detail 검사 확인, 정상 실패 객체 변경 격리 |

URL 정규화는 실제 읽기와 예산을 줄인다. 같은 URL의 표기 두 개와 KG grounding 하나가 있는 재현에서, 이전 3회 조회·3개 예산이 **2회 조회·2개 예산**으로 줄었다. 서로 다른 경로는 계속 별도 자원으로 읽는다. 이것은 resolver 호출 수의 검증이며 실제 AI 과금 토큰 절감률을 측정한 결과는 아니다.

관측의 `resources[].locator`는 작성한 주소이고, `resolution.locator`는 실제로 호출한 대표 주소다. 같은 URL의 별칭은 동일한 수집값을 공유해야 한다. 바깥 digest를 재계산하더라도 별칭에 다른 결과·대표 주소·통계를 넣으면 검증이 거부된다.

호환성: v2 형식은 유지한다. 이전 구현이 동일 URL 별칭을 별개 요청으로 중복 집계한 보고서는 다시 관측해야 한다. URL 중복이 없는 기존 보고서의 구조는 유지된다. 레거시에서 KG 결과 identity가 다른 `RESOLVES`는 이제 거부하며, `DRIFT` 등의 과거 기준은 재검사·rebind할 수 있도록 유지한다.

`npm run typecheck`와 `npm test` 모두 성공했다. 전체 **129개 통과, 실패 0개**이며 2차 감사 당시 120개에 회귀 테스트 9개를 추가했다. 새 옵션·실패 테스트 2개와 URL 중복 테스트 3개가 수정 전에 실패하는 것을 확인했다. 테스트는 가짜 resolver와 임시 자원을 사용한다. 실제 KG에 쓰거나 이전 감사 파일을 새 결과로 덮어쓰지 않았다.

최초 감사에서 별도로 남겨둔 F05·F07·F08·F10 전체를 해결했다고 판정하는 변경은 아니다. 이번 수정 범위는 사용자가 지정한 2차 감사의 다섯 항목이다.
