# Native 구현 진행 그래프

[SDK 구현](NATIVE_PROFILE.md)의 코드·테스트·실제 실행 결과를 [원래 개발 계획](NATIVE_DEVELOPMENT_PLAN.md)의 stable ID에 연결한다. 원래 계획과 24개 수용 명세는 `be6e87f450169f8caa85cba9b18b26ae436e9657`의 Git blob·SHA-256으로 고정했다. 당시 `PLANNED`/`SPECIFIED_NOT_RUN` 기록을 덮어쓰지 않는다. 이전 66개 테스트 기반 P09 구현 기록은 Git commit `e4260bc3dcc8fd2f3240d8f8fa409a106cf70dd7`에 보존되어 있다.

이번 기록은 **P01/P02/P03/P05/P06/P08/P09/P10의 한정된 구현과 실제 테스트 79개 통과 근거**다. P04/P07/P11/P12는 `PLANNED`다. [P10](NATIVE_AGENT.md)은 필수 원문 문맥·한 번의 모델 호출·등록된 P09 실행을 연결한다. 문맥 압축·인계 시 기존 전달을 철회하며, HTTP 모델 응답을 검증한다. 실제 DGX 접속은 `NOT_CONFIGURED_NOT_RUN`이고 임의 agent 도구 전체를 통제하는 구현도 아니다. 기존 계획의 모든 수용 명세를 실행했거나 USL 전체가 완성되었다는 뜻은 아니다.

[verification.json](../research/native-development/implementation/verification.json)에 별도 CLI 실행·복구 테스트 23개, 그래프 테스트 8개, 실제 RDF/SHACL 및 적대적 변조 7개, 타입·빌드·모듈 import·문서 검증 결과와 해당 산출물의 pin을 별도로 기록했다.

| 상태 | 의미 |
|---|---|
| `PLANNED` | 이번 구현 묶음에 포함하지 않은 후속 작업 |
| `PARTIAL` | 지정된 코드·테스트 파일 쌍이 아직 없음 |
| `CODE_PRESENT_NOT_VERIFIED` | 파일과 byte pin이 있고 현재 실행 근거는 없음 |
| `IMPLEMENTED_BOUNDED` | 코드·테스트의 정확한 pin과 실제 기록한 성공한 테스트 실행이 연결됨 |

[checks.json](../research/native-development/implementation/checks.json)은 명령·실행 시각·구현/테스트/fixture 파일 pin·결과 pin을 저장한다. [test-output.tap](../research/native-development/implementation/test-output.tap)은 실제 출력이다. 생성기는 command에 모든 지정 테스트 파일이 포함되는지, TAP의 pass/fail/skip/count와 출력 해시가 일치하는지 확인한다. 기록은 서명된 외부 증명이 아니며 로컬 검증 근거다. 이후 소스가 바뀌면 기존 기록의 pin이 맞지 않아 검증이 실패한다. 새 실행 근거가 필요하다.

## 그래프 계약

[graph.json](../research/native-development/implementation/graph.json)은 실제 `usl-resource-graph/v1`이며, [trace.jsonld](../research/native-development/implementation/trace.jsonld)는 같은 ID·타입·metadata와 직접 RDF 간선을 보존한다. 원래 work/requirement ID는 해당 Git blob의 JSON Pointer까지 연결한다. 실제 host root나 접근 권한은 넣지 않는다. 모든 신규 해석은 `SECONDARY_AI`이며 사용자 원문을 대체하지 않는다.

| 간선 | 방향·타입 | 작업당 수 |
|---|---|---|
| `snapshotOf` | ImplementationWork → HistoricalReference(원래 작업) | 1 |
| `addresses` | ImplementationWork → HistoricalReference(원래 요구) | 1 이상; 원래 `realizes`에서 도출 |
| `derivedFrom` | ImplementationWork → HistoricalPlanSnapshot | 0–1 |
| `implementedBy` | ImplementationWork → Artifact(role=CODE) | 구현 상태는 1 이상; P09는 dispatcher와 CLI host 2개, P10은 harness와 HTTP transport 2개 |
| `checkedBy` | ImplementationWork → Artifact(role=TEST) | 구현 상태는 1 이상; P09는 테스트·fixture 4개, P10은 테스트 2개 |
| `observedBy` | ImplementationWork → ObservedCheck | 0–1; `IMPLEMENTED_BOUNDED`는 1 |

`snapshotOf`/`derivedFrom`은 PROV derivation으로도 투영한다. 간선은 근거 연결이며 권한·동일성·효과의 원자성을 주장하지 않는다. [shapes.ttl](../research/native-development/implementation/shapes.ttl)은 RDF에 적용하는 실제 SHACL shape다. domain/range·cardinality·상태별 필수 증거·코드/테스트 역할·digest 형식을 검사한다.

검증 질문은 “P08이 R06과 실제 원문 전달 코드/테스트/실행 결과로 이어지는가?”, “P05의 코드 pin은 무엇인가?”, “P09가 실제 dispatcher·CLI host·테스트·실행 근거에 연결되는가?”, “P10이 R06/R07 및 실제 harness·HTTP 테스트에 연결되는가?”, “P11은 미완료로 남겼는가?”, “JSON-LD에서도 모든 USL 관계와 metadata가 남는가?”다. 영수증 제거·pin 훼손·미구현 작업 승격·잘못된 대상 타입·코드/테스트 역할 혼동·완료 상태 과장은 적대적 검사에서 거부한다.

## 재현

```sh
python3 scripts/build-native-implementation.py --check
TSX_DISABLE_CACHE=1 TMPDIR=/dev/shm node --import tsx --test test/native-implementation.test.ts
python3 scripts/validate-native-implementation.py
```

RDF/SHACL 검사는 [고정 Python 의존성](../scripts/requirements-standards.txt)을 사용한다. 생성만 하려면 `python3 scripts/build-native-implementation.py`를 실행한다. 새로운 실행 기록은 `--input <report.json>`으로 검증한 뒤 저장하며, `--check`는 파일을 수정하지 않는다. 이 그래프의 byte pin은 현재 checkout의 코드 내용 기준이고 원래 계획의 pin은 고정 Git revision 기준이다.
