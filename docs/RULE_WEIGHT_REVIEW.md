# 기존 W 학습 결과와 USL 정책 후보의 오프라인 연결

[규칙 웨이트 근거 계약](RULE_WEIGHT_EVIDENCE.md)에 이어, 실제 `HSWM_LIKENESS`
학습 결과를 읽고 재계산한 뒤 USL 검토 영수증으로 연결한다. 선택형
`usl/rule-weight-review`와 별도 CLI 소비 프로그램이며 코어 문법은 변경하지 않는다.

학습기는 **주어진 정책 후보 중 어떤 후보가 해당 맥락에서 나았는지** 평가한다.
효용 추정치를 새 규칙 계수로 복사하지 않는다. 후보 계수는 기존 변경 제안에
이미 명시돼 있어야 하며, 필수 규칙을 변경할 수 없다.

## 연결 방식

HSWM_LIKENESS v1은 하나의 RuleUnit ID에 한 revision만 허용한다. 서로 다른
계수를 가진 두 정책을 원자 규칙의 동일 revision으로 합치지 않고, **정책 전체
snapshot을 각각 하나의 RuleUnit**으로 연결한다. 두 action은 `policy_snapshot`
역할과 ordinal 0을 공유한다. 이 어댑터의 명시적 매핑이며 HSWM 정전 정의가 아니다.

```text
기존 정책 / 변경 후보의 정확한 원문
 → 같은 역할을 가진 두 action
 → train에서 후보 선택 → 별도 holdout 평가
 → W report 재계산·국소 복사본 replay·복원 확인
 → USL 검토 영수증 (계수 변경 / 효용 추정치 별도 필드)
```

`prepareRuleWeightReview`는 호스트가 별도로 등록한 handoff digest와 원문 파일
SHA-256을 검사하고 기존 변경 제안을 다시 계산한다. 정책 원문, W RuleUnit의
revision/bytes/evidence, action의 역할·순번, context, 배치, 보고서의 입력 digest와
5개 노드 근거 경로가 일치해야 한다. USL의 정렬된 JSON 계약 digest와 W의
`SHA256(JSON.stringify(snapshot))`는 서로 다른 해시 방식으로 구분한다.

`completeRuleWeightReview`는 같은 프로세스에서 검증한 불변 prepared 객체만 받는다.
prepared 객체를 JSON으로 보관했다가 재사용하지 않는다. 이동·인계할 때는 원본
handoff와 파일을 다시 검증한다. replay는 정확히 선택한 배치만 바꾸고 원본 규칙,
다른 배치, 복원 digest를 보존해야 한다. SDK가 받은 replay 자체는 `HOST_REPORTED`다.

| 학습기 상태 | USL 검토 결과 |
|---|---|
| `READY_FOR_OWNER_REVIEW` | `REVIEW_READY` |
| `NO_CHANGE` | `KEEP_BASELINE` |
| `UNKNOWN`, `MORE_EVIDENCE_OR_REJECT` | `HOLD` |

지원 부족을 통과로 바꾸지 않는다. 모든 결과는 `REVIEW_ONLY_NOT_APPLIED`이며,
실제 USL 정책 설치, HSWM/CHU 배치 변경, KG 쓰기 또는 접근 권한 부여는 수행하지 않는다.
호스트 등록 파일도 같은 주체가 임의로 바꿀 수 있다면 독립적인 신뢰 기준이 되지 않는다.
파일 해시는 서명·평가자의 정직성·실제 무작위화의 인증이 아니다.

## CLI 사용

```sh
npm run rule-weight-review -- --help
npm run rule-weight-review -- \
  --handoff examples/fixtures/rule-weight-review/handoff.json \
  --host examples/fixtures/rule-weight-review/host.json \
  --learner /path/to/HSWM_LIKENESS/hswm-likeness \
  --out /tmp/usl-rule-weight-review-new.json
```

`--learner`는 호출자가 명시한 실행 파일이다. 입력 그래프의 명령을 실행하지 않는다.
검증된 파일 snapshot으로 `w validate`, `w replay`만 호출한다. `w produce`나 모델
provider는 호출하지 않는다. executable의 호출자 선택과 코드 자체의 신뢰성은 구별한다.
출력 파일은 새 파일만 만들며 기존 입력·출력을 덮어쓰지 않는다.
handoff 내부 파일과 evidence는 루트 안의 일반 파일을 사용한다. symlink 경로는
지원하지 않는다. 파일당 2 MiB, 전체 16 MiB, evidence 200개로 입력을 제한하며,
학습기 호출당 시간 30초와 출력 4 MiB를 제한한다.

호스트에는 파일 경로를 검색해서 자동 등록하지 않는다. 예제 host는 고정 fixture에
맞춘 예제 등록이며 운영 승인 기록이 아니다. 경로는 handoff 기준 상대 경로를 사용해
폴더가 이동해도 정책·맥락·원문 해시를 유지한다. SDK는 I/O 없이 사용할 수 있다.

## 실제로 실행한 합성 검증

[입력 생성기](../examples/rule-weight-review-fixture.ts)는 사전에 정한 두 기억 선택
과제 유형, seed, 정책 후보와 평가 조건을 사용한다. 정책별 감점으로 답변을 선택한 뒤
별도로 정한 gold 답변 ID와 비교한다. 감점값을 성공률로 이름만 바꾸지 않는다.
128 train + 512 holdout, 총 640개 합성 단위다. 모델 호출은 없으며 latency는
합성 fixture 값이다. 프로그램 안의 선택기/평가기 분리는 독립 평가자 인증이 아니다.

기존 학습기의 `w validate`, `w run`, `w replay`를 실제 실행해 보관한
[report](../examples/fixtures/rule-weight-review/report.json)와
[replay](../examples/fixtures/rule-weight-review/replay.json)를 사용한다. 이 작성 과제에서
후보는 검토 조건을 통과했다. 실제 대시보드·운영 환경의 성능 개선은 측정하지 않았다.
기존 단일 결과는 후보 제안의 출처이며, 새 학습 표본 640건으로 복제하지 않았다.

```sh
# 기존 학습기의 설치가 없어도 보관된 결과의 결속과 생성물을 검사한다.
npm run rule-weight-review:check
npm run rule-weight-evidence:check
npm run rule-weight-evidence:standards
```

[생성물 빌더](../scripts/build-rule-weight-review.ts)는 외부 학습기를 자동 실행하거나
보관된 학습 보고서를 덮어쓰지 않는다. 입력 생성기 변경 후에는 새 입력으로 학습기를
명시적으로 재실행해야 한다. `reviewedAt`은 호출자가 선언한 시각이며 예제에서는
고정 시각이다. 실제 명령 관측은 [실행 기록](../research/rule-weight-evidence/learner-execution.json)에
따로 남긴다. 검증 결과, 소스 버전, 선언 시각, 사용자 지시의 권위를 구별한다.
