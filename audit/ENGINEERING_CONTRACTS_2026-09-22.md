# 공학 보완 계약과 비교 그래프 검증 — 2026-09-22

대상: [조사한 40항목](../docs/RESEARCH_AI_NATIVE_ADAPTERS_2026-09-22.md)을 출처·적용 한계·USL 요구·구현·반례·실행 증거로 연결하고, 실제 SDK/CLI/MCP 입력 경계에 공통 보완을 구현한 변경.

## 산출물과 구현 범위

- [생성 매트릭스](../docs/ENGINEERING_ADVERSARIAL_MATRIX.md): 40기술, 12개 공통 제어, 23개 실행한 로컬 반례 검사. 모든 기술에 남은 범위를 기록한다.
- [resource graph](../research/engineering/graph.json): 자원 263개, 역할 연결 232개. [JSON-LD](../research/engineering/graph.jsonld)는 독립 파서에서 RDF 6,387 triples로 해석됐다.
- [계약 안내](../docs/ENGINEERING_CONTRACTS.md): 역할 타입·단위·revision profile, 기능 발견, owner scope/effect, schema·크기·pin·손실 검사, 제한된 MCP/OpenAPI inventory importer, host Effect 실행 결과 영수증.
- [실행 영수증](../research/engineering/receipt.json): catalog와 전체 `src/` TypeScript, replay·builder, package/lock/tsconfig pin. `engineering:check`는 현재 코드·생성물과 일치를 확인한다. 재실행은 `engineering:build`로 한다.
- 새 runtime 의존성은 JSON Schema 검증용 `ajv` 8.20.0이다. 표준 검증은 기존 고정 Python requirements를 격리된 임시 venv에 설치해서 수행했다.

## 수행 결과

| 검증 | 결과 |
|---|---|
| `npm run typecheck` / `npm run build` | 통과 |
| `npm test` | 235/235 통과. 기존 회귀와 새 반례, 실제 CLI·MCP의 profile enforcement 포함 |
| `npm run engineering:build` | 23/23 반례 통과, 12 controls 모두 `LOCAL_CHECKS_PASS`, profile `CONFORMS` |
| `npm run engineering:check` | 현재 source pin 및 전체 생성 artifact 일치 |
| `npm run example:capability` | 검색 1건, 정상 callback 1회, 단위 불일치 요청 거부, 총 callback 1회 |
| `scripts/validate-engineering-rdf.py` | RDF/SHACL 적합, 기술 40개. 역할 타입 제거·`PROVEN_TRUE` 승격·중복 역할 3종 모두 거부 |
| `scripts/validate-rdf.py` | 기존 표준 fixture 180 triples 적합, 부정 사례 2종 거부 |
| `npm run test:lean` | 4/4 통과, 기존 공개 모델 정리 37개 및 TypeScript 일치성 사례 383개 확인 |
| 실제 CLI `context` | `technology:S03` → `requirement:S03`가 `FOUND`; `DECLARED`, `NOT_EVALUATED` 유지 |

독립 표준 결과와 입력/shape SHA-256은 [JSON 증거](engineering-standards-2026-09-22.json)에 있다. 일반 테스트 전체 로그 대신 재현 가능한 명령과 기능별 replay 영수증을 남긴다.

## 검증 중 발견하고 고친 사항

1. CLI JSON-LD 오류가 공통 Either 오류에 가려졌다. 원래 `ROLE_TYPE` 등 실패 이유를 보존하도록 수정했고 실제 CLI 테스트로 확인했다.
2. 기존 `test:lean`의 `lake --dir lean build`는 실행 위치의 기본 toolchain을 선택했다. 빌드는 4.34.0, `lean/`에서 실행한 검사는 pin된 4.33.1이 되어 `incompatible header`로 실패했다. 스크립트가 먼저 `lean/`으로 이동해 빌드하도록 수정한 뒤 정리·일치성 검사가 모두 통과했다. Lean 소스나 정리는 변경하지 않았다.
3. 불명 OpenAPI schema dialect, 미구현 구독 lifecycle, partial inventory, 변경된 실행 증거를 성공으로 받아들이지 않도록 거부/잔여 범위를 명시했다. 정상 OpenAPI fixture도 owner binding 이후 실제 callback까지 확인했다.

완료 시 미해결 검증 실패는 없다.

## 해석의 한계

외부 40제품을 설치해 공격한 보고서가 아니다. 공식 자료의 범위와 통합 반례를 AI가 정리했고, 연결된 USL 공통 제어의 로컬 반례를 실행했다. 각 외부 기술의 시나리오 전체를 재현하거나 단점을 전부 해결했다고 주장하지 않는다.

SHACL은 그래프 형태를, profile과 schema는 선언된 계약을 검사한다. 체크섬은 변경을 검출하며 실행자의 정직성·출처의 진실·외부 의미를 인증하지 않는다. 새 계약의 정확성 전체를 기존 Lean 증명 범위에 포함하지 않는다.

원격 프로토콜 driver, 자동 단위 변환·ontology 추론, 실시간 원자적 snapshot 검사, durable 실행·재개, 원격 취소·exactly-once, 모든 schema dialect 지원은 남은 범위다. host callback은 신뢰된 소유자가 제공하며 격리된 임의 코드 실행 환경이 아니다.
