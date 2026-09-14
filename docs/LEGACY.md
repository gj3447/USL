# 레거시 파일 워크플로

`pierce`, `audit`, `rebind`, records 입력의 `validate`·`project`는 초기 USL의 JSON 링크 레코드 작업이다. API와 CLI는 호환성을 위해 유지한다. JSON 파일에 링크 스냅샷을 기록하며, 별도 DB를 생성하지 않는다.

새 통합은 [범용 자원 연결](RESOURCE_GRAPH.md), [native property graph](ADAPTER_INTEGRATION.md), [Lean](LEAN4_INTEGRATION.md)에서 시작한다. 직접 작성하는 `.usl` 문법은 현재 입력 방식이며 레거시로 폐기하지 않았다.

[이전 README 원문](../archive/2026-09-14-before-consolidation/README.md)에 locator 설정, `pierce / audit / rebind`, 기준 스냅샷 갱신, KG 번들 투영의 상세 예제가 있다. `project`는 검토용 번들 파일을 만들며 기존 KG에 직접 쓰지 않는다.

`program-store.ts`는 `.usl` 파일의 컴파일 결과를 보관하는 프로세스 메모리 캐시다. 영속 등록 서비스나 새 KG가 아니다. 기존 링크 파일·관측·HSWM pin은 스냅샷이므로 과거 기준으로 유지한다.
