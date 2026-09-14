# USL 개념·연결·Lean 통합 정리

사용자의 2026-09-14 지시에 따라 DB가 아닌 의미 연결 문법·라이브러리라는 현재 기준을 정리하고, Lean 선언 연결과 USL 모델의 형식 검증을 모두 구현했다. 기존 미커밋 native adapter·CLI·MCP·HSWM 보완도 함께 검증했다.

- `resource-graph/v1`: 열린 도메인 타입, native ID, 역할 있는 다자 연결, 출처, 단항 자원 설명.
- CLI와 설정 기반 MCP의 범용 입력, JSON-LD 1.1 출력과 PROV-O 출처, SHACL 구조 검사.
- `lean4/v1`: 호스트가 지정한 Lean 실행, 선언·명제·전이 공리 export, 외부 자원 연결, 실패·간접 sorry 처리.
- Lean 모델 정리 10개 및 TS와의 100개 경로·읽기 범위 대조.
- README와 현재 설계·사용자 결정·연결 안내를 정리하고 이전 문서 23개를 원문 해시와 함께 보존.

## 검증 결과

| 실행 | 결과 |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | 210 passed, 0 failed |
| `npm run build` | PASS |
| `npm run test:lean` | Lean build + 3 integration tests PASS; 10 model theorems, 100 differential paths |
| `python scripts/validate-rdf.py` | RDF 180 triples / 4 links, SHACL conforms, 2 negative cases rejected |
| `npx tsx examples/lean4-workflow.ts` | Lean → adapter → native-ID context succeeds |
| `python scripts/check-docs.py` | 30 active documents, 23 archive hashes, 0 broken links |
| `git diff --check` | PASS |

RDF 검사는 `/tmp/usl-standards-20260914`의 격리 Python 환경에서 `scripts/requirements-standards.txt` 버전으로 실행했다. Lean toolchain은 4.33.1이다. 기본 USL 실행의 필수 의존성으로 Python이나 Lean을 추가하지 않았다.

[소스 해시와 결과](consolidation-verification-2026-09-14.json), [TS 테스트 로그](consolidation-tests-2026-09-14.log), [Lean 테스트 로그](consolidation-lean-tests-2026-09-14.log), [Lean 문맥 결과](consolidation-lean-example-2026-09-14.json).

모델 정리는 전체 TypeScript의 refinement proof가 아니며 외부 자원과 정리 사이의 의미 대응을 자동 입증하지 않는다. 14종 fixture는 연결 표현을 검증한 것이고 모든 해당 서비스의 driver를 구현했다는 뜻이 아니다. 이전 HSWM pin과 관측 기록은 당시 기준으로 보존했다.
