# AI 과제 생성 설계

> 작성: 정현 · 2026-11-20
> 근거: [담당_기술명세_정현.md](../기획/담당_기술명세_정현.md) 5.4, [기술검증_보고서_정현.md](../기획/기술검증_보고서_정현.md) 16·18, pAIr-back `poc/taskgen/`, [테이블_정의서.md](erd/테이블_정의서.md)

## 1. 한 줄 요약

관리자가 폼(직군, 난이도, 주제, 함정)을 내면 AI가 과제 전체를 만들고, 서버가 그 과제를 실제로 돌려 보며 자동 확인한 뒤 **HIDDEN**으로 저장합니다. 관리자는 과제 콘솔(팀원 4)에서 확인 결과를 보고 검수해 공개합니다.

```
관리자 폼 ─POST→ 생성 작업 시작(바로 jobId 반환)
                  │ ① 프롬프트 만들기
                  │ ② gpt-6.1-terra 구조화 출력 (JSON Schema)
                  │ ③ 자동 확인 (검사 목록)
                  │    └ 실패하면 실패 내용을 붙여 1번만 다시 생성
                  │ ④ DB 저장: tasks(HIDDEN) + task_files + task_questions …
                  └ ⑤ 확인 결과를 숨은 파일로 함께 저장
관리자 화면 ─GET(2초마다)→ 진행 단계, 끝나면 과제 code
과제 콘솔 → 확인 결과 보고 검수·편집 → OPEN
```

## 1-1. 과제 관리 상태 (2026-11-20 결정)

관리자는 과제를 세 가지로 관리합니다. DB는 `status`와 `usage` 두 칼럼 조합으로 나타냅니다.

| 관리 상태 | 뜻 | DB |
| --- | --- | --- |
| **검수 전** | 어디에도 보이면 안 됨 | `status = HIDDEN` (usage는 무엇이든) |
| **공개 문제** | 자가진단에 들어감 | `status = OPEN`, `usage = SELF` |
| **비공개 문제** | 기업 실전 시험에만 씀. 자가진단에 보이면 시험 문제 유출 | `status = OPEN`, `usage = LIVE` |

- 이미 막혀 있는 것: 자가진단 응시는 SELF 과제만 시작됨(`AttemptService`), 회차에는 LIVE 과제만 걸림(`exam_session_tasks.task_usage = 'LIVE'` FK).
- **과제 하나는 한쪽에만 씁니다.** 공개 문제를 복사해 비공개 문제로 쓰면 내용이 같아서 유출입니다. 지금 시드(V3)의 `*-live` 복사본이 자가진단 원본 내용을 그대로 쓰고 있어, 비공개 문제는 따로 만든 과제로 바꿔야 합니다.
- 용도(SELF/LIVE)는 생성 폼에서 고르고, **검수 전일 때만** 과제 콘솔에서 바꿀 수 있습니다. 한 번 공개하면 응시 기록이 용도에 묶이므로 바꾸지 않습니다.
- CLOSED(목록에는 보이고 응시는 막힘)는 공개 문제를 내릴 때만 씁니다. 세 관리 상태에는 넣지 않습니다.
- 자동 확인을 끝내 통과하지 못한 과제도 **검수 전**으로 저장합니다. 어디에도 보이지 않으므로 안전하고, 과제 콘솔에서 실패 표시를 보고 고치거나 지웁니다.

## 2. 먼저 필요한 일: 과제 내용을 DB에서 읽기 (정현이 함, 팀원 3에게 공유)

**지금 상태:** `TaskRepository`가 `classpath:tasks/{order-deadlock, pricing-plan}/` 두 폴더만 읽습니다. `tasks` 행은 DB에 있지만 설명, 파일, 숨은 파일, 후속 질문은 코드 폴더에 있습니다.
**문제:** AI가 만든 과제를 DB에 넣어도 응시 화면과 채점이 내용을 찾지 못합니다.

**바꿀 것**

| 지금 (task.json, 폴더) | 옮길 곳 |
| --- | --- |
| title, minutes | `tasks.title`, `tasks.time_limit_min` (이미 있음) |
| description, requirements (문장 배열) | `tasks.description`, `tasks.requirements` (줄바꿈으로 이은 TEXT, 이미 있음) |
| files/ | `task_files` visibility=VISIBLE |
| hidden/ (answer.md, checklist.md, 숨은 테스트) | `task_files` visibility=HIDDEN |
| followUps | `task_questions` stage=FOLLOWUP, type=ESSAY |
| notes | 직군별 공통 문구라 코드 상수로 (DEV, BIZ 각각) |
| openFile, editableFile, requiredHeadings, d4Minutes | **새 칼럼 `tasks.settings JSONB`** (ERD 변경 1건) |

- `TaskRepository`는 같은 메서드(`get`, `visibleFiles`, `hiddenFiles`)를 유지하고 읽는 곳만 DB로 바꿉니다. 그래서 응시, 채점 코드는 손대지 않습니다.
- 기존 두 과제는 시드 SQL로 DB에 넣고 classpath 폴더는 지웁니다.
- 실전 복사본(parent_task_id)이 원본 내용을 쓰는 규칙은 `TaskCatalog.definitionCode`에 그대로 둡니다.

## 3. 구조 (Template Method + 검사 목록)

```
TaskGenController        POST /api/admin/task-gen, GET /api/admin/task-gen/{jobId}
TaskGenJobs              생성 작업 상태를 메모리에 보관(재시작하면 사라져도 됨), 비동기 실행
TaskGenerator<T>         (추상) generate(form) = prompt → call → validate → (실패 시 1회 재생성) → save
 ├ DevTaskGenerator      T = DevDraft
 └ BizTaskGenerator      T = BizDraft
GenCheck<T>              (인터페이스) 검사 1개. name(), run(T) → CheckResult(ok, detail)
GeneratedTaskWriter      Draft → tasks, task_files, task_questions, question_choices, short_answer_keys, question_sources 저장
```

- 검사를 `GenCheck` 하나씩 나누면, 검사를 더하거나 빼도 생성기 코드는 그대로입니다.
- AI 호출은 기존 `com.pair.ai` 패턴(`SpringAi.openAi`, `BeanOutputConverter` 또는 JSON Schema)을 씁니다. 모델은 설정값 `pair.taskgen.model` (기본 gpt-6.1-terra), 비개발 풀이 검사 모델은 `pair.taskgen.solver-model` (기본 claude-sonnet-5-5).
- 생성 요청 기록 테이블은 만들지 않습니다(ERD 결정). 대신 확인 결과를 과제의 숨은 파일 `_gen/report.json`으로 남깁니다.

## 4. 관리자 폼

| 항목 | 값 | 비고 |
| --- | --- | --- |
| track | DEV / BIZ | |
| jobRole | 자유 입력 (백엔드, 서비스 기획, 재무 …) | |
| difficulty | 초급 / 중급 / 고급 | 기존 과제 값과 맞춤 |
| topic | 자유 입력 | 예: 쿠폰 할인 계산 |
| trap | 자유 입력 | 예: 쿠폰 두 장을 겹치면 할인이 중복 적용 |
| usage | 공개 문제(SELF) / 비공개 문제(LIVE) | 기본 SELF. 검수 전에는 콘솔에서 바꿀 수 있음 |
| minutes | 40 / 60 | 기본 60 |

## 5. AI 출력 형식

PoC(`poc/taskgen/taskgen.py`, `taskgen_biz.py`)의 스키마를 그대로 옮기고, 아래만 더합니다.

- 공통: `code`(영문 소문자·하이픈, 같은 code가 있으면 서버가 `-2`, `-3`을 붙임), `summary`(목록 카드 한 줄), `category`
- 비개발 문서는 **PDF**로 만듭니다(2026-11-20 결정). AI에게는 **페이지 배열**로 받습니다: `documents: [{path: "자료/설문_요약.pdf", pages: ["1쪽 글", "2쪽 글"]}]`. CSV는 지금처럼 텍스트로 받습니다.
- 비개발 문항의 `sources`: 근거 문서 경로 **2개 이상**과 쪽 번호 (팀 결정: 정답은 문서 여러 개를 함께 봐야 알 수 있게)

**개발 (DevDraft)**: title, summary, description[], requirements[], answer(숨은 정답 설명), files[](src/, test/), hiddenTests[], solution[](바뀐 src 파일 전체)

**비개발 (BizDraft)**: title, summary, description[], requirements[], followUps[3], documents[], csvFiles[], checklist(마크다운), trap{description, evidence}, questions[]{type SINGLE|SHORT, content, choices[4], accepted[], calc, sources[]{path, pages}}

## 6. 자동 확인 (검사 목록)

**개발** — 실행은 팀원 3의 `CodeRunner` 인터페이스(`run(sources)`)로 합니다. 설정에 따라 샌드박스로 돕니다.

| 검사 | 통과 조건 |
| --- | --- |
| 형식 | 경로가 `src/…java`, `test/…java`, 정답은 src만, 공개 테스트 1개 이상, 숨은 테스트 1개 이상 |
| 버그 힌트 주석 없음 | src 주석에 "버그, TODO, FIXME, 함정, 잘못된" 등 없음 |
| 시작 코드 + 공개 테스트 | 컴파일되고 전부 통과 |
| 숨은 테스트가 버그를 잡음 | 시작 코드 + 숨은 테스트에서 1개 이상 실패 |
| 정답은 전부 통과 | 정답 + 공개·숨은 테스트 전부 통과 |
| 시간 | 세 번 실행 각각 30초 안 |

**비개발**

| 검사 | 통과 조건 |
| --- | --- |
| 형식 | CSV 1개 이상, 문서 2개 이상, 객관식 2개 이상(보기 4개, 정답 1개), 단답형 2개 이상, 체크리스트에 "필수 항목", 후속 질문 3개 |
| CSV 형식 | 모든 행의 칸 수가 머리글과 같음 |
| 단답형 검산 | `calc` 식을 서버가 계산한 값이 인정 답안과 0.5% 안에서 같음 (식은 `v(…)`, 사칙연산, 괄호, `round`만 허용하는 작은 파서로 계산. `eval` 금지) |
| 근거 문서 여러 개 | 문항마다 근거 문서 2개 이상, 경로와 쪽이 실제로 있음 |
| 함정 근거가 자료에 있음 | trap.evidence 문장이 자료에 그대로 있음 (공백 무시) |
| 정답 노출 없음 | 설명·요구사항에 단답형 정답 수치가 없음 |
| 다른 회사 모델이 풀기 | 자료와 문항만 Claude에게 주고 풀게 해 전부 정답 |

**실패 처리**
- 하나라도 실패하면 실패한 검사 이름과 내용을 프롬프트에 붙여 **1번만** 다시 생성합니다.
- 그래도 실패하면 **검수 전(HIDDEN)으로 저장**하고 report에 실패를 남깁니다. 어디에도 보이지 않으니 안전하고, 관리자가 고쳐 쓰거나 지웁니다(생성 비용을 버리지 않기 위해). 과제 콘솔은 실패 표시를 빨갛게 보여 줍니다.
- AI 호출 자체가 실패하면(키 오류, 429) 저장하지 않고 작업을 FAILED로 끝냅니다.

## 7. 저장

| 생성 결과 | 테이블 |
| --- | --- |
| 과제 정보 | `tasks` status=HIDDEN, created_by=관리자, settings(openFile, editableFile, requiredHeadings, d4Minutes 기본값) |
| 시작 코드, 공개 테스트, CSV | `task_files` VISIBLE, `content`에 텍스트 |
| 문서(PDF) | `task_files` VISIBLE, `storage_key` + `document_pages`에 쪽별 글 (생성한 글을 그대로 넣으므로 추출이 필요 없음) |
| 숨은 테스트, answer.md, checklist.md, `_gen/report.json` | `task_files` HIDDEN, read_only |
| 기획안 틀 (비개발) | `task_files` VISIBLE `기획안.md` (결론/근거/리스크 제목만) |
| 문항 | `task_questions` TASK, `question_choices`, `short_answer_keys`, `question_sources` |
| 후속 질문 | `task_questions` FOLLOWUP ESSAY |

- 한 트랜잭션으로 저장합니다. 중간에 실패하면 과제가 반쯤 남지 않습니다.
- **PDF 만들기:** 페이지 글을 PDFBox로 한 쪽씩 써서 PDF를 만듭니다(한글 글꼴은 Pretendard를 리소스로 넣음). 파일은 `FileStorage` 인터페이스로 저장하고, 지금은 로컬 폴더 구현, 팀원 1의 S3가 생기면 바꿉니다.
- RAG 임베딩(`document_chunks`)은 생성 때 만들지 않고, 공개(OPEN)할 때 또는 첫 채점 때 만듭니다(RAG 작업에서 정함).

`_gen/report.json` 예:

```json
{ "model": "gpt-6.1-terra", "attempts": 1, "seconds": 41, "costUsd": 0.017,
  "form": { "track": "DEV", "topic": "쿠폰 할인 계산", "trap": "…" },
  "checks": [ { "name": "숨은 테스트가 버그를 잡음", "ok": true, "detail": "3개 중 2개 실패" } ] }
```

## 8. API

| 메서드 | 경로 | 권한 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/admin/task-gen` | ADMIN | 폼 → `202 {jobId}` |
| GET | `/api/admin/task-gen/{jobId}` | ADMIN | `{status: RUNNING·DONE·FAILED, step: "생성 중·확인 중·저장 중", taskCode, checks[], error}` |
| GET | `/api/admin/tasks/{code}/gen-report` | ADMIN | 과제 콘솔이 보여 줄 확인 결과 (팀원 4가 사용) |

- 동시에 도는 생성 작업은 2개까지(설정값). 넘으면 429.

## 9. 화면 (pAIr-front)

- 관리자 메뉴에 "AI 과제 만들기": 폼 → 제출하면 진행 단계 표시(2초마다 조회, 보통 40~70초) → 끝나면 확인 결과 표와 "과제 콘솔에서 검수하기" 버튼.
- 과제 콘솔 상세에 확인 결과 표를 끼우는 일은 팀원 4와 맞춥니다(위 gen-report API).

## 10. 테스트

- 검사 목록: 일부러 망가뜨린 Draft(숨은 테스트가 시작 코드에서 통과, 단답형 정답이 틀림, 근거 문서 1개)에 해당 검사가 실패하는지
- calc 파서: 허용 함수 외 호출 거절, 행이 0개·2개면 오류
- 저장: Draft 하나를 저장하고 `TaskRepository`로 다시 읽으면 같은 내용인지, 중간 실패 시 롤백
- AI 호출은 가짜 클라이언트로 바꿔 끼워 테스트(실제 호출 없음)

## 11. 구현 순서

1. **과제 내용 DB 읽기** (2장): ERD `tasks.settings` 추가, 시드, `TaskRepository` 교체
2. **개발 과제 생성** 백엔드: 추상 생성기, 검사 목록, 저장, API
3. **관리자 화면** 폼과 진행 표시
4. **비개발 과제 생성**: PDF 만들기, 문서 페이지, 문항 저장
5. (별도 작업) 응시 화면 문항 패널과 단답형 자동 채점 — 이게 있어야 비개발 문항이 자가진단에서 실제로 쓰입니다
