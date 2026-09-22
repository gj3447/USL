# 기능 카탈로그 통합 검증 — 2026-09-22

이전 `85c41d7`의 SDK capability 계약을 호스트 등록 카탈로그와 shared application으로 연결했다. CLI/MCP는 같은 발견·사전검사 입력을 사용한다. 구현 범위와 실행 예제는 [안내](../docs/CAPABILITY_CATALOG.md)를 따른다.

## 변경

- `usl-capability-catalog/v1`: immutable descriptor/policy 등록, 소유자·descriptor/source pin·중복 ID 검사, 정책 없는 발견, 정책 비노출.
- `capability_discover`, `capability_preflight`: 입력을 snapshot하고 형태·한도를 검사한 후 호스트의 등록 ID 조회. `READY`는 비실행 상태다.
- 파일 설정은 매번 최신 catalog를 검사한다. 잘못된 변경에 과거 policy를 대신 제공하지 않는다. 설정 없는 MCP는 기존 9개 tool, 등록한 서버는 11개다.
- 새 CLI는 입력·설정·등록 파일과 symlink alias를 출력 대상으로 덮어쓰지 않는다.
- 공통 JSON 데이터 검증을 `json-data.ts`로 추출하고 application에서 재수출해 기존 공개 import를 유지했다. 계약 계층의 application 역방향 의존성을 제거했다.
- OpenAPI path template·미지원 response headers/links를 명시한다. inventory 그래프는 원본을 재해석해 위조된 operation·schema·완전성을 거부한다.
- 새 dependency는 없다. 기존 40기술 검증 그래프의 C03/C07/C09와 구현 경로·추가 반례를 연결했다.

## 검증

| 실행 | 결과 |
|---|---|
| `npm run typecheck`, `npm run build` | 통과 |
| `npm test` | 249/249 통과 |
| `test/capability-catalog.test.ts` | 등록 snapshot·소유자/pin·정책 비노출·요청 경계 5개 통과 |
| `test/capability-platform.test.ts` | 실제 CLI/MCP, 최신 정책·stale descriptor, injection/예산·alias·기본 tool 호환 4개 통과 |
| `test/capability-inventory-boundaries.test.ts` | OpenAPI 누락과 inventory 위조 반례 3개 통과 |
| `npm run engineering:build`, `engineering:check` | 25개 반례 통과, 소스 pin/생성물 일치. 40기술·12 controls·자원 271개·링크 241개 |
| 독립 `validate-engineering-rdf.py` | RDF/SHACL 적합, 손상시킨 그래프 3종 거부. [입력/shape hash와 결과](capability-catalog-standards-2026-09-22.json) |
| 기존 `validate-rdf.py` | 180 triples 적합, 부정 사례 2종 거부 |
| 두 CLI 카탈로그 예제 | `FOUND`, `READY`, 동일 catalog digest, 모두 `NOT_EXECUTED` |
| `npm run example:capability` | 기존 host callback 정상 1회, 단위 불일치 요청은 거부 |
| `scripts/check-docs.py` | 문서 링크와 보존된 아카이브 hash 검사 통과 |

독립 표준 검증은 기존 requirements를 설치한 격리 venv에서 수행했다. Lean 파일·정리는 바꾸지 않았고 이번 단계에서 Lean 전체 실행을 반복하지 않았다. 새 기능에 대한 검증은 위 TypeScript 실행 및 표준 구조 검사 범위다.

완료 시 미해결 검증 실패는 없다. 카탈로그와 callback은 호스트가 신뢰하고 관리하는 경계이며, 임의 외부 코드의 격리 실행·실시간 외부 상태의 원자성·분산 실행의 정확성을 보장하지 않는다. 원문 일치 검사는 owner가 선언한 의미의 참을 증명하지 않는다.
