# AI 과제 생성 설계

> 작성: 정현 · 2026-11-20, 정리: 2026-11-25
> 이 문서는 바깥에서 보이는 부분(관리 상태, 폼, 저장, API, 화면)만 정한다.
> 생성 과정(단계, 관문, 실패 처리): [과제_생성_파이프라인.md](과제_생성_파이프라인.md) · 좋은 과제의 기준: [좋은_과제_기준.md](좋은_과제_기준.md)

## 1. 한 줄 요약

관리자가 폼을 내면 생성 작업이 비동기로 돌고([파이프라인](과제_생성_파이프라인.md)), 결과는 **검수 전(HIDDEN)**으로 저장된다. 관리자는 과제 콘솔에서 관문 결과를 보고 검수해 공개한다.

## 2. 과제 관리 상태 (2026-11-20 결정)

| 관리 상태 | 뜻 | DB |
| --- | --- | --- |
| **검수 전** | 어디에도 보이면 안 됨 | `status = HIDDEN` (usage는 무엇이든) |
| **공개 문제** | 자가진단에 들어감 | `status = OPEN`, `usage = SELF` |
| **비공개 문제** | 기업 실전 시험에만 씀. 자가진단에 보이면 유출 | `status = OPEN`, `usage = LIVE` |

- 자가진단 응시는 SELF 과제만, 회차에는 LIVE 과제만 걸린다(이미 막혀 있음).
- **과제 하나는 한쪽에만 쓴다.** 공개 문제를 복사해 비공개로 쓰면 유출이다.
- 용도는 폼에서 고르고, 검수 전일 때만 콘솔에서 바꿀 수 있다.
- CLOSED(목록에만 보이고 응시 막힘)는 공개 문제를 내릴 때만 쓴다.
- 관문을 끝내 통과하지 못한 과제도 실패 이유와 함께 검수 전으로 저장한다.

## 3. 관리자 폼 (2026-11-26: 자동 생성과 직접 만들기 분리)

| 화면 | 언제 | 입력 |
| --- | --- | --- |
| **자동 생성** (기본) | 과제를 여러 개 채울 때 | track, minutes, usage, count, mode |
| **직접 만들기** | 특정 주제가 필요할 때 | track, minutes, usage, topic, trap, competencies, mode |

| 항목 | 값 | 비고 |
| --- | --- | --- |
| track | DEV / BIZ | |
| minutes | 20 / 40 / 60 (기본 60) | 난이도는 시간으로 정함: 쉬움 / 보통 / 어려움 |
| usage | 공개 문제(SELF) / 비공개 문제(LIVE) | 기본 SELF |
| count | 자동 생성만, 1~10 (기본 10) | 상한을 넘으면 대기열로(7장) |
| topic | 직접 만들기만, 필수 200자 이내 | 예: 쿠폰 할인 계산. 추천 API로 채울 수 있음 |
| trap | 직접 만들기만, 필수 500자 이내 | 설계도가 검증된 결함 유형 목록에 맞춰 구체화 |
| competencies | 선택 | 비우면 생성기가 정함 |
| mode | 바로 생성(NOW) / 배치(BATCH) | 기본 NOW. 배치는 비용 약 절반, 느림([파이프라인 6장](과제_생성_파이프라인.md)) |
| batchDeadline | 배치일 때만, 1 / 3 / 6시간 (기본 3) | 이 시간 안에 반드시 끝남. 단계별 대기는 시스템이 나눔([파이프라인 6장](과제_생성_파이프라인.md)) |

**자동 생성의 주제·함정**
- 싼 모델 한 번 호출로 서로 다른 주제 count개를 받는다. 이미 있는 과제와 겹치는 주제는 코드가 거른다.
- 함정은 검증된 결함 유형 목록에서 과제마다 다른 유형을 고르고, AI 단독 풀이가 놓친 유형을 먼저 쓴다.
- 생성 전 주제 미리보기: 빼기·바꾸기 가능, "건너뛰기"로 바로 생성(선택).

## 4. 저장

| 생성 결과 | 테이블 |
| --- | --- |
| 과제 정보 | `tasks` status=HIDDEN, created_by=관리자, settings |
| 시작 코드, 공개 테스트, CSV | `task_files` VISIBLE, `content`에 텍스트 |
| 문서(PDF) | `task_files` VISIBLE, `storage_key` + `document_pages`에 쪽별 글 |
| 숨은 테스트, answer.md, checklist.md, `_gen/` | `task_files` HIDDEN, read_only |
| 기획안 틀 (BIZ) | `task_files` VISIBLE `기획안.md` |
| 문항 | `task_questions` TASK, `question_choices`, `short_answer_keys`, `question_sources` |
| 후속 질문 | `task_questions` FOLLOWUP ESSAY |

- 한 트랜잭션으로 저장한다. 같은 경로 파일이나 없는 근거 파일은 저장 전에 막는다.
- PDF는 쪽 글을 PDFBox로 만든다(한글 Pretendard). 파일은 `FileStorage`로 저장한다.
- RAG 임베딩은 생성 때 만들지 않고, 공개할 때 또는 첫 채점 때 만든다.
- `_gen/report.json`: 단계별 모델·토큰·시간, 관문 결과, 다시 만든 이력, AI 단독 풀이(참고 지표).

## 5. API

| 메서드 | 경로 | 권한 | 설명 |
| --- | --- | --- | --- |
| POST | `/api/admin/task-gen` | ADMIN | 직접 만들기 폼(+ mode, batchDeadlineHours) → `202 {jobId}` |
| POST | `/api/admin/task-gen/auto/preview` | ADMIN | `{track, minutes, count, exclude[]}` → 주제 `count`개 `[{situation, trap, trapType, competencies}]` |
| POST | `/api/admin/task-gen/auto` | ADMIN | 자동 생성 폼(+ 고른 topics[], 없으면 서버가 고름) → `202 {batchId, jobIds[]}` |
| POST | `/api/admin/task-gen/suggestions` | ADMIN | 직접 만들기의 주제·함정 추천 |
| GET | `/api/admin/task-gen/jobs` | ADMIN | `?active=true` 또는 `?batchId=` → 작업 목록(아래 응답과 같은 칸 + queuePosition) |
| GET | `/api/admin/task-gen/{jobId}` | ADMIN | `{status, step, mode, deadlineAt, queuePosition, taskCode, passed, checks[], error}` |
| POST | `/api/admin/task-gen/{jobId}/cancel` | ADMIN | 대기(QUEUED) 작업만 취소 |
| GET | `/api/admin/tasks/{code}/gen-report` | ADMIN | 과제 콘솔이 보여 줄 관문 결과 |

- status: QUEUED(대기) → RUNNING → DONE / FAILED / CANCELED. 동시에 도는 작업은 `pair.taskgen.max-concurrent`(10)개, **넘으면 대기열에 넣고 자리가 나면 시작**한다(2026-11-26 결정, 429 없앰).
- 모델 호출은 `infra/ai/ModelClient`로만 한다(배치는 `BatchClient`). 모델 이름은 설정에 둔다.

## 6. 화면 (pAIr-front)

- 관리자 메뉴 "AI 과제 만들기": 탭 두 개(**자동 생성**(기본) / 직접 만들기).
- 자동 생성: 폼(직군·시간·용도·개수·바로/배치·마감) → **주제 미리보기**(빼기·다시 받기, "건너뛰기"로 바로 생성) → 과제별 진행 목록.
- 진행 목록 행: 주제, 단계(대기 n번째 / 생성 단계 / 배치 대기 · 마감 시각), 끝나면 관문 통과·실패 요약과 "검수하기" 링크. `GET /task-gen/jobs?active=true`로 그려서 페이지를 떠났다 와도 이어 보인다.
- 직접 만들기: 지금 폼 + 바로/배치 선택 → 진행 단계 표시(2초마다 조회) → 관문 결과와 "과제 콘솔에서 검수하기" 버튼.
- 과제 콘솔 상세에 관문 결과(통과·실패·경고, 다시 만든 이력)를 보여 준다(gen-report API).

## 7. 실행 구조 (2026-11-26 확정)

**작업 상태는 DB에 둔다** (서버를 다시 켜도 이어 감, 공용 RDS를 여러 서버가 같이 씀)

| 테이블 | 칸 |
| --- | --- |
| `task_gen_jobs` | id, batch_id(자동 생성 묶음), env, status, step, mode(NOW/BATCH), deadline_at, form(json), admin_id, task_code, passed, checks(json), error, cost_usd, worker_id, heartbeat_at, created/started/finished_at |
| `task_gen_calls` | job_id, seq(작업 안 호출 순서), stage, input_hash, via(DIRECT/BATCH), vendor, provider_batch_id, status(PENDING/DONE), result(json), 토큰(in/out/cached), waited_ms |

- **환경 구분**: 작업마다 `env`(설정 `pair.env-name`, 예: prod, local-정현). 각 서버는 자기 env 작업만 줍는다. 로컬 서버가 운영 작업을 가져가지 않는다. 워커 스위치 `pair.taskgen.worker.enabled`(기본 true).
- **줍기**: 5초마다 `QUEUED`를 `FOR UPDATE SKIP LOCKED`로 (상한 − 내 RUNNING)개 집는다. RUNNING인데 heartbeat가 2분 넘게 끊긴 작업(서버 꺼짐)은 같은 env 워커가 다시 줍는다.
- **이어 가기**: 파이프라인을 처음부터 다시 돌리되, 모델 호출은 `(job, seq, input_hash)`가 같으면 저장된 결과를 쓴다. 비용 없이 끊긴 지점까지 간다. 코드 실행은 다시 한다.

**배치** ([파이프라인 6장](과제_생성_파이프라인.md))

- 갈림길은 `StageCallService` 한 곳: NOW는 바로 호출, BATCH는 배치 창구에 맡기고 기다린다(가상 스레드). 파이프라인 단계 코드는 그대로 둔다.
- 창구: 같은 env의 BATCH 작업 호출을 모아 회사(OpenAI/Anthropic)별로 한 배치로 보낸다. 보내는 때 = BATCH로 도는 작업이 모두 호출을 기다릴 때, 또는 첫 호출이 기다린 지 60초. 30초마다 상태를 본다.
- 단계 대기 상한(설정: 생성 20분, 관문·단독 풀이 10분)을 넘으면 안 온 호출만 취소하고 바로 호출한다. 남은 마감이 (남은 단계 × 바로 호출 평균 + 여유 15분)보다 적으면 그 작업은 이후 전부 바로 호출한다.
- 요청 본문은 바로 호출과 같은 구조화 출력(JSON 스키마)·추론 강도·출력 한도. 출력 한도 끊김은 바로 호출로 다시 부른다(지금 규칙 그대로).
- **비용 상한은 실제 낸 돈**으로 센다(2026-11-26 결정): 배치는 같은 상한 안에서 다시 만들기를 더 할 수 있다.
- `report.json`에 호출마다 via·대기 시간을 남긴다(단계 대기 기본값을 다시 정하는 근거).

**자동 생성의 주제** (2026-11-26 결정: 미리보기 넣음)

- 미리보기는 싼 모델 1번으로 `count`개. 기존 과제 제목·서로와 겹치는 것은 코드가 거르고, 모자라면 한 번 더 받는다.
- 함정 유형(DEV R1~R6, BIZ B1~B8)은 과제마다 다르게 배정하고, 최근 `report.json`에서 AI 단독 풀이가 놓친 비율이 높은 유형을 먼저 쓴다(기록이 5개 미만인 유형은 고르게).

**구현 순서**

| # | 범위 | 확인 |
| --- | --- | --- |
| 1 | 백엔드: DB 작업 상태·대기열·이어 가기(NOW) + jobs·cancel·auto·preview API | 생성 중 서버 재시작 → 모델 호출 다시 안 하고 이어서 끝남, 11개 요청 → 1개 대기 후 시작 |
| 2 | 백엔드: 배치 창구 | DEV 6개 배치(마감 1시간): 마감 안에 끝남, 비용 바로 생성의 60% 이하 |
| 3 | 프런트: 탭·자동 생성·미리보기·진행 목록·바로/배치 | Playwright e2e |

1의 API가 정해지면 3은 1과 같이 진행한다.
