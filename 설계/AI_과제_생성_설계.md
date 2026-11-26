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
| count | 자동 생성만, 1~10 (기본 10) | |
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
| POST | `/api/admin/task-gen` | ADMIN | 직접 만들기 폼 → `202 {jobId}` |
| POST | `/api/admin/task-gen/auto` | ADMIN | 자동 생성 폼 → `202 {batchId, jobIds[]}` |
| POST | `/api/admin/task-gen/suggestions` | ADMIN | 주제·함정 추천 |
| GET | `/api/admin/task-gen/{jobId}` | ADMIN | `{status, step, taskCode, checks[], error}` |
| GET | `/api/admin/tasks/{code}/gen-report` | ADMIN | 과제 콘솔이 보여 줄 관문 결과 |

- 동시에 도는 생성 작업 수는 설정값(`pair.taskgen.max-concurrent`, 10). 넘으면 429.
- 모델 호출은 `infra/ai/ModelClient`로만 한다. 모델 이름은 설정에 둔다.

## 6. 화면 (pAIr-front)

- 관리자 메뉴 "AI 과제 만들기": 탭 두 개(자동 생성 / 직접 만들기). 자동 생성은 주제 미리보기 → 과제별 진행 목록. 직접 만들기는 폼 → 진행 단계 표시(2초마다 조회) → 끝나면 관문 결과와 "과제 콘솔에서 검수하기" 버튼.
- 과제 콘솔 상세에 관문 결과(통과·실패·경고, 다시 만든 이력)를 보여 준다(gen-report API).
