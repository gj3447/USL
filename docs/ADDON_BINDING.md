# 선택 add-on 바인딩

USL 코어는 resource, meaning, 이름 있는 participant, link, provenance를
보존하는 연결 문법이다. domain rule을 실행하거나 weight를 계산하지 않는다.
도메인 CLI program 또는 add-on은 기존 resource graph 위에 자기 rule을 **선언**할
수 있다. 이 문서는 그 선언을 이식 가능하게 남기는 작은 계약이다.

## 최소 계약

[addon-binding.json](../examples/fixtures/addon-binding.json)은 하나의 n-ary link로
아래 네 참조를 연결한다.

| role | resource | 필요한 정보 |
|---|---|---|
| `rule` | `urn:usl:addon:BindingRule` | `metadata.ruleId`, `metadata.ruleVersion` |
| `target` | `urn:usl:addon:BindingTarget` | 소비자가 적용할 대상의 참조 |
| `configuration` | `urn:usl:addon:BindingConfiguration` | 소비자 전용 JSON 설정의 참조 |
| `consumer` | `urn:usl:addon:Program` | 이 선언을 해석하는 프로그램의 참조 |

그래프의 `provenance.sources`는 선언의 근거 자원이고 `activity`는 선언 활동을
나타낸다. locator는 공개 예시 주소일 뿐, USL이 읽거나 실행할 주소가 아니다.
link가 rule의 결과, 권한, 실행 성공 또는 관계의 진실을 보장하지도 않는다.

`ruleId`와 `ruleVersion`은 portable identifier다. 새 구현은 이 두 값을 보고
자기가 지원하는 rule인지 고른다. 지원하지 않으면 graph를 읽을 수는 있어도 그
rule의 효과를 추론하거나 실행하지 않는다. target/configuration/consumer는 모두
명시적 resource ID이므로 짧은 별칭이나 compact 전달 표현을 써도 원래 ID를
복원할 수 있다.

## 선택 profile 검사

[addon-binding.profile.json](../examples/fixtures/addon-binding.profile.json)은
`urn:usl:addon:applies_binding_rule`에 네 role과 그 타입을 요구한다. 또한 이
예시 rule의 identifier/version을 `rule` resource metadata에서 확인한다.

```sh
# 코어 resource graph 문법만 검사한다.
npm run usl -- adapt --format resource-graph \
  --graph examples/fixtures/addon-binding.json --namespace addon.example --operation check

# add-on 계약을 선택했을 때만 타입·role·metadata까지 검사한다.
npm run usl -- adapt --format resource-graph \
  --graph examples/fixtures/addon-binding.json --namespace addon.example \
  --profile examples/fixtures/addon-binding.profile.json --operation check
```

profile을 생략하면 base graph의 구조만 검사한다. profile을 명시하면 `ruleId`나
`ruleVersion`의 누락·불일치, 필요한 role 누락, role resource의 타입 불일치가
`adapt` 전에 거부된다. 이는 [DomainProfile](ENGINEERING_CONTRACTS.md)의 기존
검사 경로이며 rule loader, registry, 실행 engine을 새로 만들지 않는다.

선택한 profile의 ID·version·digest도 해석에 기록된다. 따라서 원본 graph와
resource/link ID는 같아도 profile을 생략했을 때와 `planDigest`는 달라질 수 있다.
이는 서로 다른 검사 문맥을 같은 cache 항목으로 취급하지 않게 한다.

## 소비자 책임

`configuration`의 `weightHint`, `hierarchyHint`, `indexHint`는 예시 consumer가
읽을 수 있는 불투명 JSON이다. weight의 계산·갱신, 상하위 해석, M index 생성과
검색, HSWM 정책 및 접근 권한은 해당 add-on/CLI program의 소유자 계약이다. USL
코어 meaning에는 이 hint의 보편 의미나 알고리즘을 넣지 않는다.

AI 문맥 전달에는 기존 `compactAgentContext`를 쓸 수 있다. `FULL` packet은
필요한 resource/meaning/n-ary link/path/coverage를 lossless projection으로
전달한다. `UNCHANGED`는 consumer가 정확히 같은 이전 FULL과 `contextDigest`를
실제로 보유할 때만 사용할 수 있다. digest 비교 자체가 cache를 만들거나 수신자
권한을 주지 않으며, 이 profile도 그러한 cache나 decoder를 구현하지 않는다.
