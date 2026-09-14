# property-graph/v2 기준 보고서·HSWM pin 전환 검토

**결론: 확인한 v2 기준과 HSWM plan pin은 이미 맞게 갱신돼 있다. 기존 보고서를 일괄 수정할 필요가 없다.** 남은 항목은 HSWM 연구 runner의 옛 기본 인자다. 새 실행에서는 최신 source manifest와 새 출력 경로를 명시해야 한다.

이 검토는 USL·HSWM의 로컬 소스, 저장된 관측, 연구 결과와 pin manifest를 읽어 비교했다. 원본·관측·정책·실행 코드는 변경하지 않았고 endpoint 재조회나 연구 재실행은 하지 않았다. 관측 형식 `usl-program-observation/v2`와 변환 규칙 `property-graph/v2`는 서로 다른 버전이다.

## 1. USL 예제의 v1 → v2 의미 변화

원본은 [native-graph.json](/home/lagyeongjun/CD/USL/examples/fixtures/native-graph.json)이다. v1·v2 MCP 검증 기록과 현재 파일이 모두 같은 원본 SHA-256을 가리킨다:

`sha256:de846e23aae9ca77849d3ad662df931bf5633fc4ba06e6da93472d2cfb5282cb`

과거 v1 변환 규칙으로 plan을 복원하고, [v1 기록](/home/lagyeongjun/CD/USL/audit/native-adapter-smoke-2026-09-08.json)의 plan digest와 정확히 일치하는지 확인했다. 현재 v2 변환은 [이미 저장된 v2 기록](/home/lagyeongjun/CD/USL/audit/native-adapter-fixes-smoke-2026-09-08.json)과 일치한다.

| 관계 | 검토 결과 |
| --- | --- |
| `game:dash-implementation` | `repo:game → game:dash`, 타입 `IMPLEMENTS`가 명시적으로 보존된다. 세 참여자의 역할→UID 연결, 원래 설명, 적용 조건·검사 계약은 그대로다. 역할 배열만 이름순으로 정렬된다. |
| `game:checkout` | `checkout:game → repo:game`, 타입 `CHECKOUT_OF`가 보존된다. 원래 없던 설명은 `null`로 표시되며 새 의미 주장을 만들지 않는다. |

주소와 리소스 선언은 동일하다. plan 변경은 방향 정보 보존, 설명 인코딩, 역할 정렬에 따른 변환 규칙 변경이다. 이 예제의 v2 plan digest는 `sha256:c2c5c433953d13ad6be90d37fe2be3d144505f7c63bd5ab34c0a52da36ade13a`다. 이 예제 MCP 기록에는 HSWM 정책 자체가 없으므로 여기서 별도 권한이나 resource pin을 발급하지 않았다.

## 2. USL의 기존 저장 관측 3개

| 저장 디렉터리 | 확인 | 조치 |
| --- | --- | --- |
| `observations/2026-09-08T05-05-11-342Z` | 게임 `.usl` 원문 재컴파일 결과와 plan·관측 digest 일치 | property-graph 전환 대상 아님 |
| `observations/engineering-2026-09-08T05-35-28-534Z` | `.usl`·GEIP 원문, plan, 관측, HSWM policy 결속 일치 | 과거 스냅샷 그대로 보존 |
| `observations/engineering-2026-09-08T05-42-29-113Z` | `.usl`·GEIP 원문, plan, 관측, HSWM policy 결속 일치 | 전환으로 추가 갱신할 pin 없음 |

세 세트 모두 receipt에 기록된 산출물 파일 hash를 확인했다. 두 engineering 세트는 현재 `prepareHswmAdapterArguments` 검증도 통과한다. 서로 다른 시점의 plan/report/policy를 혼합하면 안 된다. 이 결과는 저장된 기록의 결속 검증이며 현재 endpoint의 내용이나 관측 신선도를 다시 확인한 결과는 아니다.

## 3. HSWM 네이티브 연구 관측의 실제 plan pin

[attempt-01.json](/home/lagyeongjun/CD/HSWM/results/raw/hswm_usl_relation_synthesis_2026-09-08/attempt-01.json)은 v1, [attempt-04.json](/home/lagyeongjun/CD/HSWM/results/raw/hswm_usl_relation_synthesis_2026-09-08/attempt-04.json)은 v2 완료 기록이다. 각 기록의 `snapshot_probe.first_snapshot`에 저장된 plan/report/policy를 현재 순수 검증기에 통과시켰다. 두 스냅샷 모두 content pin 18개가 해당 저장 관측과 일치한다.

같은 native source digest를 기록하지만 의미 plan은 다르다. attempt-04에는 이미 다음 v2 plan pin이 들어 있다:

```json
{
  "namespace": "hswm.relation.instrument",
  "usl_plan_digest": "sha256:5b5cf876e9ce3bb749d4a6e2a6e71d48a44f67aa2e5a50eea809bc7e41ba5973",
  "plan_digest": "5ca6869e30d10330b1dabc9badfa176328e551e375d82b12eb8dc5920096a09e",
  "source_digest": null
}
```

이는 기존 저장 정책을 확인한 값이다. 새 정책 생성이나 실제 서비스 권한 승인이 아니다. attempt-01과 실패한 중간 시도는 과거 근거로 남겨야 한다.

HSWM의 [adapter-profile.v3.json](/home/lagyeongjun/CD/HSWM/_research/causal_composition/relation_synthesis_usl_v1/adapter-profile.v3.json)은 v2 의미 구조를 처리한다. 연구용 특징에 원본 참여자 순서가 필요할 때에는 동일 원본 digest에 결속된 순서 정보로 복원하고 역할·UID 일치를 확인한다. 전체 snapshot에는 방향과 설명을 유지한다.

## 4. 남은 항목: 연구 runner의 기본 인자

[run.mts:17](/home/lagyeongjun/CD/HSWM/_research/causal_composition/relation_synthesis_usl_v1/run.mts:17)의 기본 출력은 기존 `attempt-01.json`, 다음 줄의 기본 source manifest는 `source-pins.v1.json`이다. 반면 [현재 실행 안내](/home/lagyeongjun/CD/HSWM/_research/causal_composition/relation_synthesis_usl_v1/README.md:34)는 `source-pins.v4.json`과 새 출력 경로를 명시한다.

직접 파일 hash를 대조한 결과:

- `source-pins.v4.json`: **46개 모두 현재 HSWM·USL 소스와 일치**.
- `source-pins.v1.json`: 34개 일치, 9개 불일치. 과거 버전을 기록한 것이므로 manifest 자체를 덮어쓸 대상은 아니다.

runner는 기존 결과 파일을 `wx`로 보호하고 source drift를 검사한다. 따라서 옛 기본값이 조용히 v2 관측으로 승인되는 것은 아니다. 현재 무인자 실행은 기존 출력 충돌로, 새 출력만 지정한 실행은 옛 source pin 불일치로 실패할 수 있다. 이 동작은 소스 검토와 hash 대조로 확인했으며 연구를 실제 실행하지 않았다.

새 시도에는 `--source-pins .../source-pins.v4.json`, hash가 일치하는 `--usl-root`, 기존 기록과 다른 `--output`을 함께 지정해야 한다. 기본값을 현대화하려면 runner 코드와 그 코드를 pin하는 manifest를 새 버전으로 함께 관리해야 하며, 기존 연구 기록을 고치면 안 된다. 이번 요청은 검토이므로 실행 기본값과 pin은 변경하지 않았다.

## 재현 증거

- [의미·관측·plan pin 비교 JSON](property-graph-v2-migration-review-2026-09-08.json)
- [HSWM source manifest 비교 JSON](hswm-property-graph-v2-pin-review-2026-09-08.json)
- [재현 스크립트](review-property-graph-v2-migration-2026-09-08.ts): `npx --no-install tsx audit/review-property-graph-v2-migration-2026-09-08.ts`

소스 변경이 없는 검토이므로 전체 테스트와 build를 반복하지 않았다. 필요한 원문 재컴파일, 관측 검증, HSWM 정책 검증과 hash 대조만 실행했다.
