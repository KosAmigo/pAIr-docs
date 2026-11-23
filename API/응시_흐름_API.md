# 응시 흐름 API 명세

> 작성: 문희 · 2026-11-23 · 대상: 프론트, 팀원 · 상태: **구현됨** (pAIr-back `develop`)
> 기준 구현: pAIr-back `backend/src/main/java/com/pair/web/ApiController.java` 및 `com/pair/attempt/`, `com/pair/question/`
> 범위: 자가진단 응시(과제 선택 → 편집 → 빌드·실행 → AI 채팅 → 제출 → 후속 질문 → 리포트)와 복기(체크포인트·트리·비교·롤백).
> 채팅 첨부 상세는 [채팅_첨부_API.md](채팅_첨부_API.md), 과제 자료 PDF는 [응시_자료_PDF_API.md](응시_자료_PDF_API.md)를 본다.

## 공통 규칙

| 항목 | 규칙 |
|---|---|
| 인증 | `Authorization: Bearer <Access Token>` |
| 응시 소유 확인 | `/api/attempts/{id}/**` 는 인터셉터가 한곳에서 검사한다. 자가진단 응시는 로그인하지 않으면 401, 다른 회원의 응시면 403, 없는 응시면 404. 실전 응시(`user_id` 없음)는 여기서 검사하지 않는다(실전 입장은 [실전시험_감독_API.md](실전시험_감독_API.md)) |
| 내 것만 | 복기 API(`tree`, `compare`, 체크포인트 이름·롤백)는 내 자가진단 응시만 다룬다. 남의 것·실전 응시는 있는지도 알려 주지 않고 404 |
| 오류 | HTTP 상태 코드와 `{"message":"사용자에게 표시할 문장"}`. 400 입력·단계 오류, 401·403 인증·권한, 402 크레딧 부족, 404 대상 없음, 503 AI 실패·실행 대기열 초과, 500 그 밖 |
| 단계 | 응시 `status`: `SOLVING`(풀이) → `FOLLOWUP`(후속 질문) → `SCORING`(채점 중) → `DONE` / `ERROR`. 단계가 맞지 않는 요청은 400 `지금 단계(…)에서는 할 수 없는 요청입니다.` |
| 시간 | ISO-8601 UTC. 대화 턴의 `time` 은 응시 시작부터 경과한 `HH:MM:SS` |
| 크레딧 | 응시 시작 10, AI 질문 10(+새 첨부 파일당 5), 롤백 10. 부족하면 402. 값은 `pair.credit.*` |

## 1. 흐름 요약

1. `GET /api/tasks` → 과제 고르기, `POST /api/attempts` 로 응시 시작 (크레딧 10 차감).
2. 풀이 중(`SOLVING`): 파일 저장·빌드·실행·편집기 도우미·AI 채팅·수정 제안 적용·문항 답 저장.
   AI 질문마다 체크포인트가 하나씩 자동으로 생긴다.
3. `POST …/submit` → `FOLLOWUP`. `POST …/followups` 로 후속 질문에 답하면 채점이 비동기로 시작(`SCORING`).
4. `GET …/report` 를 폴링해 `DONE` 이면 리포트를 읽는다. 실패(`ERROR`)면 `POST …/rescore`.
5. 복기: 체크포인트 목록 → 롤백으로 갈라진 새 응시 → 트리 → 두 풀이 비교.

## 2. 과제·응시 시작

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/tasks?track=dev\|biz` | 자가진단 과제 목록. `track` 은 직군 필터(선택) |
| GET | `/api/tasks/{taskId}` | 과제 정의(응시자에게 공개 가능한 부분) |
| POST | `/api/attempts` | 응시 시작 |
| GET | `/api/attempts` | 내 기록 목록(최근 순) |
| GET | `/api/attempts/{id}` | 응시 상세(풀이 화면 첫 로딩) |

과제 목록 항목: `{id, type, title, minutes, status}`.

**POST `/api/attempts`**

```json
{ "taskId": "order-deadlock" }
```

응답 `{"attemptId": 123}`. 자가진단(SELF) 과제가 아니거나 `OPEN` 이 아니면 400, 크레딧이 모자라면 402.

**GET `/api/attempts`** — 내 자가진단 응시. 응시 행을 먼저 만들고 크레딧을 차감하므로 들어갔다 아무것도 안 하고 나간 기록(질문·저장·빌드·실행 없음)은 목록에서 뺀다.

```json
[{
  "id": "123", "taskId": "order-deadlock", "taskTitle": "…", "taskType": "…",
  "startedAt": "2026-11-23T05:00:00Z", "status": "DONE",
  "total": 72, "legacyReport": false,
  "<항목 key>": 3.5
}]
```

`DONE` 이면 항목 key(예: 역량 키)마다 점수가 평평하게 붙는다. `total` 은 감점식 리포트(`version` ≥ 2)만 있고, 이전 형식이면 `null` + `legacyReport: true`(다시 채점 필요).

**GET `/api/attempts/{id}`**

| 필드 | 내용 |
|---|---|
| `attempt` | 응시 상태(`status`, `startedAt`, `submittedAt`, `followUpAnswers` …) |
| `task` | 과제 정의 |
| `files` | 작업 파일 경로 목록 |
| `turns` | 대화 턴 `[{turn, role, time, text, edits, attachments}]`. `role` 은 `user` / `ai`, `edits` 는 §5 수정 제안, `attachments` 는 채팅 첨부 요약 |
| `chatMaxChars` | 질문 1회 최대 글자 수(현재 1000) |
| `elapsedSeconds` | 시작부터 제출(또는 지금)까지 경과 초 |

## 3. 파일·빌드·실행

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/attempts/{id}/file?path=` | 저장된 파일 내용 `{path, content}`. 없으면 404 |
| PUT | `/api/attempts/{id}/file?path=` | 저장. 본문 `{"content":"…"}`. 풀이 중에만 |
| POST | `/api/attempts/{id}/build` | 컴파일만 |
| POST | `/api/attempts/{id}/run` | 컴파일 + 테스트 실행 |

- `logs/`, `자료/` 아래와 과제에서 `read_only` 로 정한 파일은 저장할 수 없다(400 `읽기 전용 파일은 고칠 수 없습니다`). AI 수정 적용도 같다.
- 저장·빌드·실행은 모두 이벤트로 기록된다(채점 근거).
- 빌드·실행은 `src/`, `test/` 아래 `.java` 만 대상으로 한다.

**빌드 응답** `{compiled, lines, diagnostics, millis}`
**실행 응답** `{compiled, lines, passed, failed, tests, diagnostics, millis}`

```json
{
  "compiled": true,
  "lines": ["…출력 줄…"],
  "passed": 2, "failed": 1,
  "tests": [{ "name": "orderTest", "passed": false, "message": "expected … but was …" }],
  "diagnostics": [{ "file": "src/shop/Order.java", "line": 12, "column": 5, "severity": "error", "message": "…" }],
  "millis": 5400
}
```

실행 모드는 `pair.run.mode`(`local` 서버 JVM / `docker` 격리 컨테이너, 환경변수 `PAIR_RUN_MODE`)로 고른다. docker 모드에서는 동시 실행 상한(4)을 넘으면 최대 60초 줄을 서고, 넘으면 **503** `실행 대기열 초과`로 거절한다. 이때는 잠시 뒤 다시 시도하면 된다.

## 4. 편집기 도우미 (입력 중 분석)

저장하지도, 기록을 남기지도 않는다. 앱 서버 JVM에서 javac API로 메모리 분석한다(실행 모드와 무관). 동시 분석 4개, 파일 40개, 40만 자 한도.
`files` 는 화면의 **저장 전 내용**(경로 → 내용)으로, 서버에 저장된 파일 위에 덮어 분석한다. **새 경로는 무시**한다(이미 있는 파일의 수정본만 반영).

| 메서드 | 경로 | 본문 | 응답 |
|---|---|---|---|
| POST | `/api/attempts/{id}/diagnostics` | `{files}` | `{"diagnostics":[{file,line,column,severity,message}]}` |
| POST | `/api/attempts/{id}/complete` | `{files, path, offset}` | `{"items":[Completion]}` |
| POST | `/api/attempts/{id}/definition` | `{files, path, offset}` | `{"definition": Definition \| null}` |

`offset` 은 `path` 파일 안의 글자 위치(0부터).

```json
// complete 의 Completion
{ "name": "getItems", "kind": "method", "signature": "getItems()", "hasParams": false, "importName": null }
// definition 의 Definition (작업 파일 안에 선언이 없으면 definition 이 null)
{ "file": "src/shop/Order.java", "line": 8, "column": 18, "kind": "method", "name": "getItems" }
```

- `complete`: "식." 뒤는 그 타입의 멤버, 점 없이 글자를 친 자리는 지역 변수·매개변수·둘러싼 클래스 멤버·작업 파일 클래스·`java.lang`·import 한 클래스. import 하지 않은 자주 쓰는 라이브러리 클래스는 `importName` 과 함께 나가고, 프론트가 선택 시 import 문을 넣는다. 최대 100개, 대소문자 무시, `Object` 멤버 제외.
- `severity` 는 `error` / `warning`. 열(`column`)은 javac 가 탭을 8칸으로 세는 것과 달리 글자 위치에서 직접 계산해 편집기 기준과 맞춘다.

## 5. AI 채팅과 수정 제안

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/attempts/{id}/chat` | 질문 하나, 답이 다 오면 한 번에 응답 |
| POST | `/api/attempts/{id}/chat/stream` | 같은 질문을 SSE 스트리밍으로 |
| POST | `/api/attempts/{id}/edits` | 수정 제안 적용·거절 |
| GET | `/api/attempts/{id}/attachments/{attachmentId}` | 질문에 붙였던 첨부 원문 |

**요청**

```json
{ "message": "락 순서가 문제인가요?", "attachments": [{ "source": "ATTEMPT_FILE", "path": "src/shop/OrderService.java" }] }
```

`attachments` 는 선택이고 형식·한도는 [채팅_첨부_API.md](채팅_첨부_API.md) 를 따른다.

**응답(`/chat`)** 새로 생긴 턴 2개(질문, 답변) `[TurnView, TurnView]`.

```json
[
  { "turn": 1, "role": "user", "time": "00:03:12", "text": "…", "edits": [], "attachments": [] },
  { "turn": 2, "role": "ai", "time": "00:03:20", "text": "…", "edits": [ EditView ], "attachments": [] }
]
```

**스트리밍(`/chat/stream`, `text/event-stream`)** 이벤트 3종.

| 이벤트 | data |
|---|---|
| `delta` | `{"t":"글자 조각"}` 답변이 오는 대로 반복 |
| `done` | `[TurnView, TurnView]` 저장까지 끝난 새 턴 2개 |
| `error` | `{"message":"…"}` 실패(질문은 저장되지 않음) |

화면을 닫으면 서버가 받기를 멈춘다. 타임아웃 6분.

**규칙**

- 메시지가 비면 400. 한 질문은 `chatMaxChars`(1000자) 이하, 응시당 AI 질문은 40회까지(`max-turns`).
- 처리 순서: ① 첨부 검증·크레딧 잔액 확인(읽기만) → ② AI 호출(트랜잭션 밖) → ③ 질문·답·체크포인트·크레딧 차감을 **트랜잭션 하나**로 저장. AI가 실패하거나 빈 답이 오면 아무것도 저장·차감하지 않고 503을 낸다(채점에도 반영되지 않는다).
- 같은 응시의 채팅·수정 결정은 한 번에 하나씩 처리한다(다른 응시끼리는 동시에).
- 크레딧은 자가진단 응시에만 차감한다.

**수정 제안(`EditView`)** AI 답변 중 ` ```edit path=… ` 블록을 서버가 읽어 턴의 `edits` 에 붙인다.

```json
{ "index": 1, "path": "src/shop/OrderService.java", "hunks": [ { … } ], "newFile": false, "status": "PENDING", "applicable": true }
```

`status` 는 `PENDING`(결정 전) / `APPLIED` / `REJECTED`. `applicable` 은 지금 파일에서 바꿀 부분을 찾을 수 있는지(`APPLIED` 면 false).

**POST `/edits`**

```json
{ "turn": 2, "index": 1, "action": "apply" }
```

`action` 은 `apply` 또는 `reject`(그 외 400). 응답 `{"status":"APPLIED","path":"…","content":"바뀐 파일 전체"}` (거절이면 `content` 가 null).
이미 적용했으면 400, 바꿀 부분을 못 찾으면 400 `지금 파일에서 바꿀 부분을 찾지 못해…`. 적용은 읽기 전용 검사를 거쳐 파일 저장(+이벤트·첫 유효 판정)까지 한 번에 하고, AI 제안으로 새로 만들 수 있는 경로는 `.java`·`.md` 만(`logs/`·`자료/`·상위 경로 `..` 불가).

## 6. 문항(객관식·단답형)

과제에 문항이 있으면 풀이 화면에서 함께 푼다. 역량 6개 점수와 **따로** 채점한다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/attempts/{id}/questions` | 문항과 내가 저장한 답. 정답 정보는 내보내지 않는다. 문항이 없으면 `[]` |
| PUT | `/api/attempts/{id}/questions/{questionId}/answer` | 답 저장(덮어쓰기). 풀이 중에만 |

```json
// GET 응답 항목
{ "id": 7, "seq": 1, "type": "CHOICE", "content": "…", "points": 5,
  "choices": [{ "id": 31, "seq": 1, "content": "…" }],
  "answer": { "choiceIds": [31] } }
// PUT 요청: 객관식은 choiceIds, 단답형은 text
{ "choiceIds": [31] }   // 또는 { "text": "…" }
```

`answer` 는 `choiceIds`(객관식) 또는 `text`(단답형) 중 하나만 나간다. 빈 답을 보내면 답 지우기이고 응답은 JSON `null`.

## 7. 제출·후속 질문·채점·리포트

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/attempts/{id}/submit` | 제출. `SOLVING` → `FOLLOWUP` |
| POST | `/api/attempts/{id}/followups` | 후속 질문 답. 본문 `{"answers":["…","…"]}`, 채점이 비동기로 시작 |
| POST | `/api/attempts/{id}/rescore` | 다시 채점. 후속 질문까지 끝난 응시만(아니면 400) |
| GET | `/api/attempts/{id}/report` | 상태와 리포트 |

`submit`·`followups`·`rescore` 는 갱신된 `Attempt`(`id, taskId, status, startedAt, submittedAt, followUpAnswers, followUpQuestions, error …`)를 돌려준다. `followUpQuestions` 는 응시자가 답할 때 본 질문 문구를 저장한 것이라 과제 질문이 나중에 바뀌어도 채점은 본 질문으로 한다.

**GET `/report`**

```json
{
  "status": "DONE",
  "error": null,
  "report": { "version": 2, "total": 72, "items": [ … ], "transcript": [ … ] },
  "questions": { "score": 10, "max": 15, "items": [ { "seq": 1, "type": "CHOICE", "content": "…", "points": 5, "score": 5, "yourAnswer": "…", "correctAnswer": "…", "correct": true } ] }
}
```

- `status` 가 `DONE` 일 때만 `report`·`questions` 가 있고 그 전에는 `null`. 채점 중(`SCORING`)에는 이 API 를 폴링한다. `ERROR` 면 `error` 에 사유가 있고 `rescore` 로 다시 채점한다.
- `report.items[]` 는 역량 항목(`key`, `name`, `score`, 체크별 감점 근거). `version` 2 이상이 감점식이고 이전 형식은 다시 채점해야 총점이 나온다. 필드의 세부(체크 코드, 감점 근거)는 [채점_기준표.md](../평가/채점_기준표.md) 를 따른다.
- `report.transcript[]` 는 채점 때 저장한 대화 사본인데, 서버가 읽을 때 질문 턴마다 `attachments`(채팅 첨부 요약)를 얹는다. 저장된 리포트는 바꾸지 않는다.
- 정답(`correctAnswer`)은 제출 뒤 리포트에서만 나간다.

## 8. 복기: 체크포인트·롤백·트리·비교

AI 질문마다 체크포인트가 하나 생긴다(질문을 보낸 순간의 작업 파일 상태). 체크포인트에서 **롤백**하면 그 시점으로 복원된 새 응시가 갈라져 나온다.

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/attempts/{id}/checkpoints` | 이 응시의 체크포인트 목록 |
| PATCH | `/api/checkpoints/{checkpointId}` | 이름 붙이기 |
| POST | `/api/checkpoints/{checkpointId}/rollback` | 롤백 |
| GET | `/api/attempts/{id}/tree` | 복기 트리 |
| GET | `/api/attempts/{id}/compare?with={otherId}` | 두 풀이의 감점 근거 비교 |
| GET | `/api/attempts/{id}/compare/files?with={otherId}` | 두 풀이의 코드 변경 비교 |

**체크포인트** `[{checkpointId, turnNo, label, createdAt}]`. `turnNo` 는 질문 턴 번호.

**PATCH `/api/checkpoints/{id}`** 본문 `{"label":"락 순서 고침 전"}` → 갱신된 체크포인트. 빈 값이면 이름을 지운다. 100자를 넘으면 400. 내 체크포인트가 아니면 404.

**POST `/rollback`** → `{"attemptId":"456"}`.

- 새 응시는 체크포인트 시점의 파일로 시작하고, 그 앞의 대화 턴(과 첨부)을 복사한다. 첨부 복사에는 크레딧을 다시 차감하지 않는다.
- 롤백 1회에 크레딧 10 차감(부족하면 402). 원래 응시는 그대로 남는다.
- 새 응시는 `SOLVING` 이라 이어서 풀고 제출·채점까지 갈 수 있다.

**GET `/tree`** 이 응시가 속한 트리의 모든 응시(뿌리 포함).

```json
[
  { "attemptId": "123", "parentAttemptId": null, "forkedAtTurn": null, "forkedFromCheckpointId": null,
    "status": "DONE", "startedAt": "…", "score": { "total": 72, "max": 100, "items": [{ "key": "…", "name": "…", "max": 20, "score": 15 }] } },
  { "attemptId": "456", "parentAttemptId": "123", "forkedAtTurn": 3, "forkedFromCheckpointId": 88, "status": "SOLVING", "startedAt": "…", "score": null }
]
```

뿌리(원래 응시)만 `parentAttemptId`·`forkedAtTurn`·`forkedFromCheckpointId` 가 null. `score` 는 채점이 끝난(`DONE`) 응시만 있고 채점 전이거나 이전 형식 리포트면 null.

**GET `/compare?with=`** 두 풀이 모두 채점이 끝난 내 풀이여야 한다(아니면 400 `채점이 끝난 풀이만 비교할 수 있습니다.`).

```json
{ "a": "123", "b": "456", "items": [{
    "key": "…", "name": "…", "max": 20, "a": 15, "b": 20,
    "checks": [{ "code": "…", "label": "…", "method": "…", "points": 5, "changed": true,
                 "a": { "status": "DEDUCTED", "deducted": 5, "reason": "…", "evidence": ["…"] },
                 "b": { "status": "PASSED", "deducted": 0, "reason": "…", "evidence": [] } }]
}]}
```

`Side.status` 는 `DEDUCTED`(감점) / `PASSED`(통과) / `SKIPPED`(적용 안 함) / `NO_EVIDENCE`(근거 없어 감점 안 함) / `SPLIT`(판정 엇갈림). 한쪽 리포트에 없는 체크는 그쪽이 `null`. `changed` 는 두 풀이의 상태나 감점이 다르다는 뜻.

**GET `/compare/files?with=`** 같은 과제의 풀이끼리만 비교할 수 있다(다르면 400 `같은 과제의 풀이끼리만…`).

```json
[{ "path": "src/shop/OrderService.java", "base": "과제 원본 내용", "a": "A 최종 내용", "b": "B 최종 내용" }]
```

그 파일이 없으면 해당 값이 null(`base` 가 null 이면 풀이에서 새로 만든 파일). 원본·A·B 가 모두 같은 파일은 제외한다.

## 9. 성능·한도 참고

| 항목 | 값 |
|---|---|
| 체크포인트 복원 | 중앙값 2.5~5.3ms, 최대 9.7ms (파일 11개 6KB, 질문 40개, 실제 Postgres) |
| 롤백(새 응시 만들기) | 질문 40개에서 99~151ms |
| 편집기 분석 | 요청 한 번 15~35ms, 동시 4개 한도에서 약 110~150건/초 |
| 코드 실행(docker 모드) | 동시 1개 5.5초, 4개 7.2초, 8개 8.8초, 16개 28초 (실행당 CPU 1·메모리 512MB·제한 30초) |

모두 개발 PC에서 잰 값이다. 원격 DB·낮은 사양 서버에서는 달라진다.

## 10. 알려진 한계

- 실전 응시(`user_id` 없음)는 이 API를 초대 토큰으로 들어와 쓰므로 소유 확인을 거치지 않는다. 실전 입장 인증은 팀원 4와 정할 일이다.
- 기본 실행 모드가 `local`(서버 JVM 직접 실행)이다. 배포 때 `PAIR_RUN_MODE=docker` 로 지정해야 한다. 앱 서버와 샌드박스 서버를 나누는 `RemoteDockerRunner` 는 아직 코드에 없다.
- 대시보드는 목록 API와 최근 리포트를 따로 불러 응시 5개 기준 약 50쿼리를 쓴다. 복기 트리는 노드마다 리포트 JSON을 읽어 점수만 뽑는다.
