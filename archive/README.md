# USL 과거 설계와 기록

현재 문서는 [README](../README.md), [구조](../docs/ARCHITECTURE.md), [사용자 결정](../docs/DECISIONS.md)이다.

`2026-09-14-before-consolidation/`에는 정리 직전 README와 docs 22개, 총 23개를 그대로 복사했다. 이미 작업 트리에 있던 미커밋 9/8 수정도 포함한다. [manifest](2026-09-14-before-consolidation/manifest.json)는 원래 저장소 상대 경로와 파일별 SHA-256을 기록한다. 보관본 내부의 상대 링크는 **당시 원래 저장소 경로** 기준이며, 보관본을 최신 사용 안내로 취급하지 않는다.

다음 개념을 구분했다.

- **초기 레코드 중심 구현:** `pierce / audit / rebind`, JSON 링크 스냅샷. [레거시 안내](../docs/LEGACY.md).
- **`.usl` 중심 설명:** 현재도 선택 입력이지만 모든 통합의 필수 전처리가 아니다.
- **다음 문법 제안:** 초기 `adapter / bind` DSL, inverse·자동 실행 제안은 과거 설계다. 구현된 TypeScript `bind`와 혼동하지 않는다.
- **날짜별 테스트·HSWM pin 기록:** [audit](../audit/README.md), `observations/`에 원본 그대로 둔다. 과거 hash·실행 결과를 최신 소스에 맞춰 다시 쓰지 않는다.

이 아카이빙은 과거 사용자 발화를 폐기하지 않는다. 후속 사용자 지시가 이전 구현 선택을 구체화한 이력은 현재 결정 문서에 남긴다.
