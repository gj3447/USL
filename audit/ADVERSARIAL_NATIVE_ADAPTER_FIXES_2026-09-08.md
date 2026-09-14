# USL 어댑터 적대적 검증 후속 수정 — 2026-09-08

이전 [감사 보고서](ADVERSARIAL_NATIVE_ADAPTER_2026-09-08.md)의 F1–F7을 수정했다. 전체 테스트 **192개 통과, 실패 0개**, 타입 검사와 빌드 통과. 실제 로컬 파일을 사용하는 빌드된 CLI, stdio MCP, 기존 HSWM Python 소비자 전달까지 확인했다.

## 수정과 회귀 검증

| 항목 | 수정 | 확인한 결과 |
| --- | --- | --- |
| F1 의미 정보 누락 | `property-graph/v2` meaning에 타입, 순서 있는 from/to, 설명의 존재 여부를 고정 구조 JSON으로 보존 | 같은 관계 UID·n-ary 참여 역할에서 방향 반전 시 plan·meaning digest가 달라지고 `REVIEW_SEMANTIC_CONTRACT` 발생. 타입·설명 인코딩 충돌도 분리됨 |
| F2 query 덮어쓰기 | SDK의 context 추가 옵션에 허용된 키·타입만 수용하고 별도 query 보존 | 추가 `query` 키 거절, 원본 조회 0회. 정상 `maxHops: 0`은 유지됨 |
| F3 반환 객체 별칭 | JSON 데이터 검증 후 graph/result 복제, 그 복사본으로 digest 생성·깊은 동결 | 호출자 원본의 상태·evidence를 변경해도 반환 결과와 receipt 유지. getter 입력은 실행 없이 거절 |
| F4 조회 이후 검증 | SDK와 application의 사전 검증 공유. HSWM authority 구조는 원본 조회 전, plan pin은 endpoint 조회 전 확인 | malformed 옵션·권한은 source/resolver 0회. 잘못된 plan digest·pin 범위는 source 1회 후 resolver 0회로 거절 |
| F5 snapshot 검증 차이 | `captureAdaptedGraph`로 plan·원본 정보·identity map 검증 공통화, 공개 snapshot에 출력 한도 적용 | 빈 identity map은 snapshot/check 모두 거절. 정확한 출력 한도는 성공, 한도 초과는 거절 |
| F6 파일 전체 읽기 | 하나의 열린 file handle에서 바이트를 누적하며 최대 한도+1까지만 읽고 `finally`로 닫음 | 큰 파일과 stat 이후 커지는 파일 모두 읽기 상한 유지, 초과 실패 뒤 close 확인. CLI는 출력 파일을 만들지 않음 |
| F7 배열 순서에 의한 재검토 | 역할명으로 식별하는 participants를 안정적으로 정렬 | 역할→UID 연결이 같은 배열의 순서 변경은 native source digest만 바뀜. 의미 변경 false, 재검토 actions 없음 |

관계 방향 테스트는 실제 `RESOLVES` 관측 두 개를 비교한다. 주소와 내용이 그대로인 상태에서 의미 변경만 판정되는지 확인한다. 참여자 정렬은 이름으로 식별하는 역할 연결에 적용하며, 선언된 check 순서는 유지한다.

공개 `snapshot()`의 출력 한도와 내부 plan의 크기는 구분한다. 작은 compact 결과를 요청할 때 내부 plan이 그 출력 한도보다 크다는 이유만으로 거절하지 않는다. 원본 응답과 변환한 graph에는 입력 한도를 적용한다.

회귀 검증 파일:

- [property-graph.test.ts](/home/lagyeongjun/CD/USL/test/property-graph.test.ts): 방향·타입·설명 충돌, n-ary 보존, 실제 관측 비교.
- [adapter-boundaries.test.ts](/home/lagyeongjun/CD/USL/test/adapter-boundaries.test.ts): query, receipt, 사전 IO 차단, identity map, snapshot 출력 한도, HSWM pin, 큰 요청.
- [bounded-read.test.ts](/home/lagyeongjun/CD/USL/test/bounded-read.test.ts): 실제 read 바이트 계측, 파일 성장, UTF-8 경계, 핸들 종료, CLI 출력 보호.
- [hswm-integration.test.ts](/home/lagyeongjun/CD/USL/test/hswm-integration.test.ts): 기존 전달 계약, authority 사전 검증, plan mismatch, 객체 변경 격리.

## 공식 문서에서 확인한 근거

Neo4j는 관계의 시작 노드, 끝 노드, 하나의 타입과 방향을 명시한다. 이를 USL의 의미 표현에 보존해야 한다는 판단으로 F1의 변환 구조를 보강했다. v2 JSON 구조 자체는 USL의 어댑터 계약이다. [Cypher Core concepts](https://neo4j.com/docs/cypher-manual/25/queries/concepts/#_relationships)

Node.js 문서는 `readFile`이 파일 전체를 버퍼링한다고 설명한다. `FileHandle.read`로 읽기 크기를 직접 제한하고 동일 handle의 stat/read/close를 사용했다. 테스트는 실제 읽은 바이트와 close 이벤트를 계측한다. [Node.js File system](https://nodejs.org/api/fs.html#filehandlereadbuffer-offset-length-position), [readFile의 버퍼링](https://nodejs.org/api/fs.html#fsreadfilepath-options-callback)

Zod의 strict object는 알 수 없는 키를 오류로 처리한다. SDK의 기존 JSON 경계에도 이 원칙을 적용해 옵션을 조용히 버리거나 다른 필드에 합치지 않고 거절한다. getter·상속 옵션은 복사 전에 검사한다. [Zod strictObject](https://zod.dev/api#zstrictobject)

WHATWG의 structured cloning은 데이터를 직렬화·역직렬화해 새 값을 만든다. 반환 결과를 복제한 뒤 그 복사본의 digest를 계산하도록 변경했다. JSON으로 표현할 수 없는 데이터나 accessor는 사전 검사로 거절한다. [WHATWG structured data](https://html.spec.whatwg.org/multipage/structured-data.html#structured-cloning)

## 버전과 사용 영향

입력 `{nodes, relations}` 형식과 공개 연결 방식은 유지된다. 변환 규칙은 `property-graph/v2`로 바뀌어 의미·plan digest가 새로 계산된다. 기존 v1 기준 보고서와 독립적으로 관리하는 HSWM plan pin은 새 plan을 검토한 뒤 갱신해야 한다. 과거 관측이나 호출자 권한은 자동 수정하지 않는다. 이후 정상 호출에서는 최신 원본으로 변환하므로 수동 `.usl` 작성이나 별도 컴파일 명령이 필요하지 않다.

host가 제공하는 custom `read` callback은 자체 DB·네트워크 수신량을 제한해야 한다. SDK의 완료된 응답 크기 검사만으로 callback 내부의 IO를 중단할 수는 없다. 내장 CLI에는 실제 읽기 상한을 구현했다.

로컬 HSWM 검증의 `READY`는 참조 접근 가능성을 나타낸다. 의미적 진실이나 실행 권한을 뜻하지 않는다. native source digest는 USL receipt에 있고, HSWM v2의 USL 원문 결합은 기존대로 `ABSENT`다. 잘못된 source pin은 거절된다.

실제 검증 대상 파일의 SHA-256, 검사 로그, 수정 항목별 상태는 [검증 기록](native-adapter-fixes-verification-2026-09-08.json)에 있다. CLI·MCP·HSWM 결과와 HSWM 소비자 파일 digest는 [전달 검증 기록](native-adapter-fixes-smoke-2026-09-08.json)에 있다. 기존 감사 당시의 원본 증거는 보존했다.
