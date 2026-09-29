# USL 단순 바인딩 문법의 압축 조사

2026-09-29 조사. USL 코어는 Resource·Meaning·이름 있는 Participant·Link와
출처를 보존하는 단순 바인딩 문법이다. 압축은 그 구조를 바꾸는 새 DSL이나
실행 엔진이 아니다. 문법의 반복 선언을 줄이는 무손실 표현과, 같은 payload를
전달·저장·문맥화하는 선택 경로를 각각 증거에 따라 검토한다.
원문 ID, 역할, reference, metadata, provenance는 모든 **lossless** 경로에서
복원 가능해야 한다.

## 먼저 구분할 측정값

| 값 | 뜻 | 서로 바꿔 읽으면 안 되는 이유 |
|---|---|---|
| UTF-8 bytes | 파일·wire payload 크기 | 모델 tokenizer와 1:1이 아니다 |
| tokens | 지정 모델·tokenizer가 센 입력 단위 | tokenizer/version마다 달라진다 |
| parsed heap | decode 뒤 객체가 차지하는 메모리 | bytes가 작아도 parse 객체는 클 수 있다 |
| total billing | uncached input + cached-read + optional cache-write + output의 실제 usage와 가격, 재호출 비용 | local estimate나 cache hit만으로 확정할 수 없다 |
| quality/retry | 누락·오해·parse failure 뒤 재호출 비용 | 작은 prompt가 항상 더 싼 결과를 뜻하지 않는다 |

로컬 tokenizer는 텍스트 encoding의 추정치다. [OpenAI의 공식 token counting
guide](https://developers.openai.com/api/docs/guides/token-counting)처럼 model·
message role·tool 정의에 따른 request overhead를 따로 고려해야 하며, plain
encoding count를 billed model request usage로 읽지 않는다. 총비용은 실제 usage와
output, cache-write/read bucket, 실패 뒤 retry를 함께 기록해 계산한다. 입력 비용
bucket은 provider의 과금 규칙에 따라 중복 없이 구분한다.

## 현재 USL 경로

`compactAgentContext`는 lossless JSON transport form이다. FULL에는 필요한
resource·meaning·n항 link·path·coverage를 담고, path step을 tuple로 반복
압축한다. 소비자가 이전 FULL을 실제로 보유한 경우에만 그 digest를 보내야 하며,
함수는 제공된 digest와 현재 digest를 비교할 뿐 소비자 cache를 관리하지 않는다.
일치할 때 `UNCHANGED` packet을 반환한다. UTF-8 byte 예산과 선택 tokenizer
counter의 token 예산을 넘으면 부분 payload 대신 거부한다. [구현](../src/language/compact.ts) ·
[사용 계약](COMPACT_CONTEXT.md).

이는 `FULL`/`UNCHANGED`와 exact digest에 관한 구현 보장이다. 모델별 token,
parsed heap, provider 청구액, 품질·재시도 개선은 측정값이 공급되기 전까지
이 저장소에서 미측정이다.

현재 byte/token 예산은 직렬화한 출력의 한도다. 전체 context를 만든 뒤 검사하므로
heap 상한을 보장하지 않는다. 메모리 개선은 별도의 peak heap 측정과 함께 판단한다.

## 오프라인 측정 결과

2026-09-29에 고정 fixture 세 개를 `cl100k_base`, `o200k_base` 두 encoding으로
세었다. 아래 표의 token은 `o200k_base` plain-text count이며, 두 encoding의 원시
결과와 digest는 [결과 파일](../research/compression/benchmark-results.json)에 있다.
이는 API 요청의 message/tool overhead나 청구 usage가 아니다. 각 source minified
형태는 재-parse한 뒤 원본과 같은 `planDigest`임을 확인했다.

| fixture | 비교 대상 | UTF-8 bytes | o200k tokens | 판정 |
|---|---:|---:|---:|---|
| agent navigation | source 810 → minified 666 | -17.8% | 169 → 145 (-14.2%) | whitespace/comment 최소화가 같은 plan으로 복원됨 |
| resource graph + metadata | source 5,527 → minified 3,589 | -35.1% | 1,377 → 825 (-40.1%) | JSON source 표현의 반복 공백 감소 |
| generated medium USL | source 5,174 → minified 4,717 | -8.8% | 1,591 → 1,414 (-11.1%) | 같은 plan으로 복원됨 |
| agent navigation context | minified context 2,774 → compact FULL 2,353 | -15.2% | 670 → 603 (-10.0%) | tuple path transport projection |
| resource graph context | minified context 21,038 → compact FULL 13,284 | -36.9% | 9,068 → 5,140 (-43.3%) | tuple path·반복 field 절감 |
| generated medium context | minified context 38,184 → compact FULL 17,084 | -55.3% | 11,185 → 5,098 (-54.4%) | 반복 구조가 큰 경우의 측정값 |

`source-*` lane은 원래 USL/graph source 전체이고, `context-*`와 `compact-full`은
그 source에서 질의로 선택한 scoped agent context다. 따라서 source와 context의
크기를 서로 같은 payload의 압축률로 비교하지 않는다. `context-pretty`와
`context-minified`는 정확히 같은 JSON 값이며, FULL은 경로와 target witness를
재구성하는 transport projection이다.

실험용 generic dictionary/table codec은 JSON exact round-trip과 malformed alias
거부를 통과했지만 채택 근거가 되지 않았다. metadata fixture에서 standalone
dictionary는 compact FULL보다 bytes가 6.9% 작았다(12,373 vs 13,284) 해도 tokens는
7.3% 많았다(5,513 vs 5,140). 세 fixture 모두 standalone dictionary의 token 수가
FULL보다 컸다. 그러므로 이 codec은 연구 전용이며 USL 코어에 넣지 않는다.

기존 `UNCHANGED` packet은 238 bytes, o200k 기준 108~112 tokens였다. 수신자가
동일한 FULL을 실제로 보유하고 있을 때만 의미가 있으므로, stateless model prompt의
내용을 대신하지 않는다. gzip/brotli와 base64 lane도 결과 파일에 기록했지만 이는
wire/storage 비교일 뿐 prompt 표현의 승자가 아니다. parsed heap, API 청구액,
cached-token usage, 모델 품질과 retry는 이 측정에서 재지 않았고, CBOR·zstd·TOON도
구현하거나 USL fixture로 측정하지 않았다.

### 재현

이 측정은 API 호출 없이 동작한다. `tiktoken==0.12.0`은
[`scripts/requirements-compression.txt`](../scripts/requirements-compression.txt)에
고정되어 있다.

```sh
python3 -m venv /tmp/usl-compression-venv
/tmp/usl-compression-venv/bin/python -m pip install -r scripts/requirements-compression.txt
USL_TIKTOKEN_PYTHON=/tmp/usl-compression-venv/bin/python node --import tsx scripts/benchmark-compression.ts
USL_TIKTOKEN_PYTHON=/tmp/usl-compression-venv/bin/python node --import tsx scripts/benchmark-compression.ts --check
```

세 번째 명령은 결과 JSON을 다시 생성하고, 네 번째 명령은 fixture·script digest와
현재 결과의 일치를 검사한다. 다른 Python 환경을 사용할 때는
`USL_TIKTOKEN_PYTHON`에 그 interpreter 경로를 지정한다.
결과에는 Node/Python/tokenizer 버전도 들어 있으므로 완전히 같은 파일을 재현하려면
결과 파일의 환경을 맞춘다. 새 환경에서 재생성한 결과는 변경된 측정으로 검토한다.

## 같은 구조를 어디에서 줄일지

| 층 | 후보 | 기대하는 효과 | 제한 |
|---|---|---|---|
| native syntax | canonical ID를 보존한 짧은 로컬 별칭/복원표, 역할 이름 재사용, sidecar/profile 참조 | 사람이 읽는 선언과 중복 감소 | canonical identity를 줄이거나 role을 생략하지 않는다 |
| context/wire text | compact JSON, schema/dictionary 재사용, uniform array table encoding | 반복 key·path 전달 감소, tokenizer별 측정 후보 | 외부 text format은 model 이해·token count·복원 검증이 필요 |
| transport/storage | CBOR, zstd | bytes·I/O·저장량 감소 | decode 전에는 모델 문맥이 아니며 base64/gzip이 token 감소를 보장하지 않는다 |
| consumer prompt cache | 안정된 prefix와 exact digest | 반복 요청 latency/청구 구조 개선 가능 | context window를 줄이거나 cache hit를 보장하지 않는다 |
| learned compression | LLMLingua2류의 추출 | 자연어 보조 설명의 token 후보 감소 | lossy이므로 core payload·필수 근거에는 사용하지 않는다 |

[`RFC 8949`](https://www.rfc-editor.org/rfc/rfc8949.html)의 CBOR는 structured
data의 binary representation이고, [`RFC 8878`](https://www.rfc-editor.org/rfc/rfc8878.html)의
zstd는 lossless byte compression이다. 둘 다 wire/storage에는 후보지만 모델에
그대로 넣을 prompt encoding은 아니다.

TOON은 line-oriented JSON-data encoding이며 uniform object array에서 field
목록을 한 번 쓰는 방식을 제공한다. [공식 TOON specification](https://github.com/toon-format/spec)은
working draft다. USL에서는 ID·role·provenance가 있는 fixture를 JSON과 동일
의미로 round-trip한 뒤 모델별 tokens와 parse 오류를 비교할 때만 후보로 둔다.

OpenAI의 [prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)는
유사 요청의 prefix cache를 다룬다. cache는 payload token 수나 context window를
없애지 않으며, 일치하는 prefix와 provider 조건이 필요하다. 보편적인 절감률을
약속하지 않는다.

LLMLingua-2는 learned extractive prompt compression 연구다.
[원 논문](https://arxiv.org/abs/2403.12968)은 task-agnostic compression을
다루지만, token/lexical unit을 제거할 수 있으므로 lossless USL binding core나
필수 연구 의존성이 될 수 없다.

## 문법 자체의 비용 의식 규칙

USL 문법도 단순성을 잃지 않는 범위에서 반복을 줄일 수 있다. 다음은 구현
지시가 아니라 round-trip·token 측정 뒤에만 검토할 표현 규칙이다.
현재 문법은 이미 resource·meaning을 이름으로 선언해 link에서 재사용한다.
이번 minify 함수와 dictionary codec은 연구 스크립트에만 있으며 새 CLI 옵션은 아니다.

1. resource URI, meaning, role schema는 선언 한 곳에서 정의하고 link에서는
   stable alias로 재사용한다.
2. alias는 문서 scope 안에서 canonical ID로 복원 가능해야 하며, 원래 ID를
   대체하거나 다른 자원과 합치지 않는다.
3. pretty form과 optional whitespace-minified form은 같은 AST·digest 의미로
   parse되어야 한다.
4. positional/table shorthand는 반복 participant 집합에만 additive·versioned
   form으로 검토한다. named role, metadata, provenance를 생략하지 않고 JSON
   round-trip과 tokenizer·quality 증거가 있을 때만 제안한다.

## 제안: 측정 뒤에만 선택

1. 현재 fixture에서 compact JSON의 bytes, 선택 tokenizer tokens,
   FULL→UNCHANGED와 구조 round-trip을 계속 검증한다. heap은 별도 계측으로만
   추가한다.
2. JSON 이외의 dictionary/table text, CBOR, zstd는 각각 decoder·canonical digest·
   model/token 증거를 갖춘 별도 후보로 비교한다. binary는 decode 뒤 canonical JSON과
   digest가 일치해야 한다.
3. 실제 provider 호출이 별도로 허용된 benchmark에서 모델별 usage, cached tokens,
   latency, task success와 retry를 기록한다. provider cache와 local digest cache를
   구분한다.
4. 모든 후보가 ID/role/reference/metadata/provenance를 보존하고 품질 기준을
   통과할 때만 optional transport/context encoding으로 제안한다.

이 조사는 새 program engine, HSWM 규칙의 core 편입을 제안하지 않는다. 다만
선언 재사용, scope-local alias, whitespace-minified form처럼 canonical ID와
named role을 보존하는 문법 개선은 USL 자체의 후보이며, 위와 같은 semantic
round-trip과 tokenizer 증거가 있을 때만 추가한다. 가중치, 계층, M-map index와
도메인 규칙은 USL 위의 CLI program 또는 선택 add-on이 profile/metadata/named
link로 소유한다.

## 조사 출처

정규화된 메타데이터와 각 기법의 범위·제한은
[`research/compression/sources.json`](../research/compression/sources.json)에
있다. 6개 출처는 2026-09-29에 원문을 열어 확인했다.
