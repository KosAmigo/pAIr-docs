# 실전 시험·감독 API 명세 (프론트 ↔ 백엔드)

> 작성: 팀원 4 (실전 시험 흐름) · 2026-11-19
> 프론트는 이 명세대로만 부른다. 호출 코드는 pAIr-front `frontend/src/proctor/api/proctorApi.ts` 한 파일에 모여 있어서, 주소가 바뀌면 그 파일만 고치면 된다.
> 참고 구현: pAIr-back `backend/src/main/java/com/pair/exam/` (Spring Boot, JPA, PostgreSQL). 그대로 옮겨 써도 된다.

## 0. 공통

| 항목 | 규칙 |
|---|---|
| 시각 | 모두 ISO-8601 UTC 문자열 (`2026-12-01T06:00:00Z`). **판단은 서버 시각으로만** 한다 |
| 오류 | HTTP 상태 + `{"message": "사용자에게 그대로 보여 줄 한국어 문장"}` |
| 상태 코드 | 400 입력·상태 오류, 404 없는 토큰·회차, 413 파일 너무 큼 |
| 응시자 인증 | 로그인 없음. 메일 링크의 **초대 토큰(invite)** 이 곧 본인 확인. 43자 `[A-Za-z0-9_-]`, `SecureRandom` 32바이트. **DB 에는 SHA-256 해시(`invite_token_hash`)만** 저장하고, 원문은 초대 메일에만 담는다. 다시 보내면 새 토큰이 나오고 이전 링크는 막힌다 |
| 입장 링크 | `{프론트 주소}/entry?invite={초대 토큰}` |

**개인정보 원칙 (동의서 문구와 맞춰야 함)**
- 영상은 서버로 보내지 않는다. 카메라 분석은 응시자 브라우저 안에서만 한다.
- 이상이 확정된 순간에만 이벤트 1건과 JPEG 사진 1장(320px, 보통 10~20KB)을 보낸다.
- 얼굴을 식별하지 않는다(누구인지가 아니라 얼굴이 있는지만 본다).
- 사진은 **회차 종료 30일 뒤** 지우고 `snapshot_deleted_at` 만 남긴다.
- 감독 이벤트는 자동 탈락이 아니라 담당자가 확인(OK/SUSPECT)하는 기록이다.

---

## 1. 응시자 API (프론트 `Entry.tsx`, `RealExam.tsx`, 휴대폰 페이지가 부름)

### 1-1. `GET /api/time` 서버 시각
```json
{ "serverNow": "2026-12-01T05:58:12.345Z" }
```
프론트는 `서버 시각 - 내 시각` 을 보정값으로 써서 카운트다운을 그린다.

### 1-2. `GET /api/entry/{invite}` 입장 정보
```json
{
  "sessionTitle": "2026 하반기 신입 개발자 역량평가",
  "companyName": "(주)넥스트커머스",
  "name": "김지원",
  "email": "jiwon.kim@example.com",
  "startsAt": "2026-12-01T06:00:00Z",
  "endsAt": "2026-12-01T07:00:00Z",
  "serverNow": "2026-12-01T05:58:12Z",
  "phase": "UPCOMING",
  "proctoring": true,
  "consented": false,
  "startedAt": null,
  "submittedAt": null,
  "taskIds": ["order-deadlock"],
  "attempts": {},
  "tasks": [{ "taskId": "order-deadlock", "attemptId": null, "submitted": false }]
}
```
- `phase`: `UPCOMING`(시작 전) · `LIVE`(진행 중) · `ENDED`(종료) · `CANCELED`(취소됨, 입장·시작 불가) — 서버 시각 기준
- `companyName` 은 선택. 없으면 프론트는 비워 둔다
- `attempts`: 과제 ID → 응시 ID. 시작 전에는 빈 객체
- `tasks`: 과제별 진행 상태 (회차 과제 순서). `submittedAt` 은 **모든 과제**를 낸 시각

### 1-3. `POST /api/entry/{invite}/consent` 감독 동의 + 환경 점검 결과
```json
{ "consentVersion": "v1", "envCheck": { "passed": true, "items": [ ... ], "phone": { ... } } }
```
- `envCheck` 는 프론트 환경 점검 결과 JSON 그대로 (최대 20,000자). 다시 점검하면 덮어쓴다
- 종료·취소된 회차면 400. 응답: 1-2 와 같은 입장 정보

### 1-4. `POST /api/entry/{invite}/enter` 대기실 입장
처음 들어온 시각만 기록한다 (`entered_at`). 응답: 입장 정보.

### 1-5. `POST /api/entry/{invite}/start` 시험 시작
- **서버 시각 ≥ startsAt** 이어야 한다. 아니면 400 `아직 시작 시각이 아닙니다.` (프론트는 1초 뒤 다시 시도)
- 감독 회차인데 동의 기록이 없으면 400
- 과제마다 응시(attempt)를 만든다. **두 번 불러도 응시는 한 번만** (대상자 행 잠금, `SELECT ... FOR UPDATE`)
- 응답: 입장 정보 (`attempts` 가 채워짐). 프론트는 첫 응시로 `/exam/{attemptId}?mode=live` 로 이동

### 1-6. `POST /api/entry/{invite}/tasks/{taskId}/submit` 과제별 제출
- 그 과제의 응시만 제출한다. 제출한 과제부터 채점을 시작한다 (팀원 1 채점 큐)
- 모든 과제를 내면 대상자도 제출 완료 (`submittedAt`, `submit_kind=MANUAL`)
- 이 회차 과제가 아니면 404, 시작 전이면 400, 종료 시각이 지났으면 400 (스케줄러가 남은 과제를 대신 제출한다)
- 두 번 불러도 안전. 응답: 입장 정보

### 1-6b. `POST /api/entry/{invite}/submit` 남은 과제 모두 제출 (시험 끝내기)
- 아직 풀고 있는 응시를 모두 제출하고 `submit_kind=MANUAL`. 규칙은 1-6 과 같다

### 1-8. `POST /api/entry/{invite}/env-scan` 환경 점검 사진 1장
방 360도는 휴대폰을 12구간(30°씩)으로 나눠 구간마다 한 장, 책상 위는 몇 장을 올립니다. 시험 시작 전 입장 단계에서 올립니다.
```json
{ "stage": "ROOM", "angle": 45, "objects": ["person", "cell phone"], "image": "data:image/jpeg;base64,/9j/4AAQ..." }
```
| 필드 | 규칙 |
|---|---|
| `stage` | `ROOM`(방 360도) · `DESK`(책상 위) |
| `angle` | 방 스캔에서 이 사진을 찍은 방향 0~359. 책상은 비움 |
| `objects` | 사진에서 감지한 물체 이름, 최대 12개 |
| `image` | JPEG 만, 감독 사진과 같은 크기 한도 |
- 응답 `201`: `{id, participantId, stage, angle, objects[], phoneSuspect, sizeBytes, capturedAt, deleted}`. `objects` 에 `cell phone` 이 있으면 `phoneSuspect=true`.
- 감독을 쓰지 않는 회차, 취소된 회차, 종료 5분 뒤, 대상자당 100장 초과는 거절(400). 잘못된 링크는 404.
- 감독 이벤트(`proctor_events`)와 **따로** `env_scan_photos` 테이블에 저장해 이벤트 목록·통계에 섞이지 않습니다. 파일은 감독 사진과 같은 저장소(`env-scan/{회차}/{사진}.jpg`)에 올리고, 회차 종료 30일 뒤 파일만 지웁니다.
- 콘솔: `GET /api/console/sessions/{id}/participants/{pid}/env-scan`(목록), `GET /api/console/sessions/{id}/env-scan/{photoId}/image`(사진). 감독관도 볼 수 있습니다.
- 방 스캔(`ROOM`)에서 사람·휴대폰·책·화면이 잡혀도 응시를 막지 않고 점검 결과에 경고로만 남습니다. 감독관이 콘솔의 "환경 점검 사진"("확인 필요" 표시)에서 확인하고 치우도록 안내합니다. 책상 위(`DESK`)에서 응시자가 "휴대폰이 아니다"라고 확인하고 진행한 경우도 경고로 남고 이 사진을 감독관이 확인합니다.

### 1-7. `POST /api/entry/{invite}/proctor-events` 감독 이벤트 1건
```json
{
  "type": "NO_FACE",
  "source": "PC_CAM",
  "startedAt": "2026-12-01T06:12:03.120Z",
  "durationMs": 2100,
  "confidence": 0.91,
  "detail": { "faceCount": 0 },
  "snapshot": "data:image/jpeg;base64,/9j/4AAQ..."
}
```
| 필드 | 규칙 |
|---|---|
| `type` | 아래 표 |
| `source` | `BROWSER` · `PC_CAM` · `PHONE_CAM` |
| `startedAt` | 이상 상태가 시작된 시각. `startsAt - 1분` ~ `서버 시각 + 1분` 밖이면 400 |
| `durationMs` | 0 ~ 3,600,000 |
| `confidence` | 선택, 0~1 |
| `detail` | 선택, 자유 JSON (최대 4,000자) |
| `snapshot` | 선택, JPEG data URL 또는 base64. **카메라 이벤트만**, 최대 200KB, JPEG 매직(FF D8 FF) 확인 |

- 시작하지 않은 응시자, 감독 없는 회차, 종료 5분이 지난 뒤의 요청은 400
- 사진은 S3 `exam-snapshots/{회차ID}/{이벤트ID}.jpg` (SSE-S3, 비공개 버킷, 회차 종료 30일 뒤 삭제)
- **업로드 실패 시 이벤트도 롤백**한다. 프론트 아웃박스가 다시 보낸다 (네트워크 오류·5xx 만 재시도, 4xx 는 버림)
- 응답 201: `{ "id": 12, "type": "NO_FACE", "source": "PC_CAM", "startedAt": "...", "durationMs": 2100, "confidence": 0.91, "detail": "{...}", "snapshot": "ok", "snapshotBytes": 14203, "review": null, "reviewNote": null, "reviewedBy": null, "reviewedAt": null }`

**이벤트 유형** (DB 코드표 `proctor_event_types`: 경고 문구·심각도 LOW/MEDIUM/HIGH)

| type | source | 뜻 |
|---|---|---|
| `TAB_HIDDEN` `WINDOW_BLUR` `MOUSE_LEAVE` `PASTE` `FULLSCREEN_EXIT` | BROWSER | 탭·창 이탈, 외부 붙여넣기, 전체 화면 해제 |
| `NO_FACE` `MULTI_FACE` `HEAD_TURN` `HEAD_DOWN` `GAZE_AWAY` `TORSO_SHIFT` `TORSO_TURN` | PC_CAM | 얼굴 없음, 여러 얼굴, 고개 돌림, 오래 숙임, 시선 이탈, 자리 이동, 몸 돌림 |
| `HAND_MISSING` `HAND_MOVED` `ARM_MOVE` `PHONE` `EXTRA_SCREEN` `BOOK` | PHONE_CAM | 손 이탈, 손 위치 이탈, 팔 움직임, 휴대폰, 다른 화면, 책 |
| `PHONE_DISCONNECTED` | PHONE_CAM | 휴대폰 캠 연결 끊김·응답 없음·화면 이탈 (**릴레이 서버가 만든다**) |

> 브라우저 이벤트는 지금 기존 `/api/anti-cheating/sessions/{attemptId}/violations` 로 간다 (pAIr-front `frontend/src/anti-cheating`). 백엔드를 새로 만들 때 1-7 로 합쳐도 되고, 그러면 `ViolationApi.ts` 만 바꾸면 된다.

---

## 2. 휴대폰 보조 캠 릴레이 (WebSocket `/ws/proctor`)

PC 와 휴대폰을 잇는다. **영상은 오가지 않는다.** 메시지는 모두 JSON 문자열. 최대 2MB.

### 2-1. 연결 순서
```
PC  ── hello-pc {invite} ─────────────▶ 서버: 초대 토큰 확인, 짝 코드 발급
PC  ◀── paired {pairCode, phoneUrl} ──  서버   (PC 는 phoneUrl 을 QR 로 보여 줌)
폰  ── hello-phone {pairCode} ────────▶ 서버: 짝 코드 확인
폰  ◀── phone-joined                    PC ◀── peer {phone:"connected"}
폰  ── violation / phone-status / scan-frame / check-report ─▶ 서버 ─▶ PC
```
- **짝 코드는 초대 토큰과 다른 값**이다 (QR 에 초대 토큰을 넣지 않는다). 대상자당 하나, 재접속해도 같은 값
- 휴대폰 페이지 주소: `{프론트 주소}/proctor/phone?p={pairCode}` (카메라 때문에 HTTPS 필요)
- 같은 짝 코드로 폰이 새로 붙으면 예전 폰 연결은 끊는다

### 2-2. 클라이언트 → 서버
| type | 보내는 쪽 | 내용 | 서버 처리 |
|---|---|---|---|
| `hello-pc` | PC | `{ invite }` | 토큰 확인. 틀리면 `error` 후 종료 |
| `hello-phone` | 폰 | `{ pairCode }` | 짝 확인. 틀리면 `error` 후 종료 |
| `violation` | 폰 | `{ violation: { id, kind, type, message, startedAt, ts, durationMs, detail?, snapshot? } }` (시각은 epoch ms) | **1-7 로 저장** (`source=PHONE_CAM`, 응시자가 시작한 뒤만). 사진을 뺀 내용을 PC 로 전달 |
| `phone-status` | 폰 | `{ status: { fps, handCount, objects[], calibrated, bytesSent } }` 1초마다 | 마지막 수신 시각 갱신, PC 로 전달 |
| `scan-frame` | 폰 | `{ stage: "room"\|"desk"\|"ear-left"\|"ear-right"\|"wrist", image: "data:image/jpeg;base64,...", objects[], angle? }` | PC 로 전달. `room`·`desk` 는 릴레이가 §1-8 로 파일 서버에도 올림(귀·손목은 올리지 않음). `angle` 은 방 스캔에서 찍은 방향(0~359도) |
| `check-report` | 폰 | `{ report: { passed, items[] } }` | PC 로 전달 (PC 가 1-3 에 함께 저장) |

### 2-3. 서버 → 클라이언트
| type | 받는 쪽 | 내용 |
|---|---|---|
| `paired` | PC | `{ pairCode, phoneUrl }` |
| `phone-joined` | 폰 | `{}` |
| `peer` | PC | `{ phone: "connected" \| "disconnected" \| "stale" }` |
| `violation` | PC | 폰 경고 (사진 없이) |
| `phone-status` `scan-frame` `check-report` | PC | 폰이 보낸 그대로 |
| `error` | 둘 다 | `{ message }` |

### 2-4. 서버가 직접 만드는 이벤트
- 폰 연결이 끊김 → `PHONE_DISCONNECTED`
- 폰이 감시 중(`calibrated=true`)인데 **6초** 동안 아무 메시지가 없음 → `peer: stale` + `PHONE_DISCONNECTED`
- 둘 다 응시자가 시작한 뒤에만 저장한다 (시작 전 점검 중 끊김은 기록 안 함)

> 개발용 릴레이: pAIr-front `frontend/server/proctorRelay.ts` (Vite 개발 서버 플러그인). 위 규칙을 그대로 구현했고, 폰 이벤트는 백엔드 1-7 로 보낸다. 운영 백엔드에서는 Spring WebSocket 으로 같은 동작을 만들면 된다.

---

## 3. 기업 콘솔 API (콘솔 화면이 `frontend/src/data/consoleApi.ts` 로 부른다)

**인증·회사 분리.** 모든 콘솔 API 는 로그인한 사용자(`CurrentUser`)를 받는다. 지금은 목업 로그인이 헤더로 보낸다:
`X-Pair-User-Id`, `X-Pair-Role`(MANAGER·PROCTOR·ADMIN), `X-Pair-Company-Id`(기업 회원만). 백엔드 `pair.auth.mode=header`(개발용).
팀원 1 이 Spring Security 를 붙이면 `CurrentUserResolver` 구현만 바꾸고 API 는 그대로 둔다.

| 상황 | 응답 |
|---|---|
| 로그인 정보 없음·형식 틀림 | 401 |
| 역할이 안 됨 (감독관이 회차 관리·결과, 응시자가 콘솔) | 403 |
| 다른 회사 회차 | 404 (있는지도 알리지 않음) |

MANAGER: 자기 회사 회차 관리·대상자·결과·감독. PROCTOR: 자기 회사 회차 보기·이벤트·사진·판정. ADMIN: 모든 회사, 회차를 만들 때 `companyId` 를 넣는다. 기업 회원이 보낸 `companyId` 는 무시하고 로그인한 회사로 저장한다.


| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/console/sessions` | 내 회사 회차 목록 + 인원 집계·미확인 이벤트 수(`unreviewedEvents`). 관리자는 `?companyId=` 로 좁히고 없으면 전체 (취소한 회차는 `phase=CANCELED`, `canceledAt`) |
| POST | `/api/console/sessions` | 회차 생성 `{companyId, title, startsAt, endsAt, proctoring, taskIds[]}` |
| GET·PUT | `/api/console/sessions/{id}` | 상세 · 수정(시작 전만, 시간·과제·이름이 바뀌면 대상자에게 변경 안내 메일) |
| POST | `/api/console/sessions/{id}/rescue` | 종료된 회차에서 채점 단계에 가지 못한 응시(풀이 중·후속 질문 단계)를 다시 채점으로 넘김. 관리자·매니저만, 종료된 회차만. `{pending, failed}` 를 돌려줌. 이미 채점 단계인 응시는 건드리지 않아 여러 번 불러도 안전. 채점에 AI 호출 비용이 듦 |
| POST | `/api/console/sessions/{id}/cancel` | 취소(시작 전만). **지우지 않고** `canceled_at` 을 남기고 대상자에게 취소 안내 메일 |
| POST | `/api/console/sessions/{id}/participants` | 대상자 추가 `{participants:[{name,email}]}` → `{added, rejected:[{line,name,email,reason}]}` |
| POST | `/api/console/sessions/{id}/participants/csv?dryRun=` | 대상자 CSV(.csv, 2MB, 최대 1,000명) 업로드. 첫 행 `이름,이메일`. UTF-8(BOM 가능)·MS949 모두 읽음. `dryRun=true` 면 저장 없이 미리 보기(`added` = 등록될 인원). 저장하면 원본을 `participant-csv/{회차}/{업로드 ms}.csv` 에 보관(`participants_csv_key`). 틀린 행 하나 때문에 전체를 거절하지 않음 |
| GET | `/api/console/sessions/participants-template.csv` | 대상자 CSV 양식 내려받기 |
| DELETE | `/api/console/sessions/{id}/participants/{pid}` | 명단에서 빼기 (시작 전 회차, 입장 전 대상자만) |
| POST | `/api/console/sessions/{id}/participants/{pid}/invite` | 초대 메일 다시 보내기 (**새 토큰 발급, 이전 링크 무효**) |
| GET | `/api/console/sessions/{id}/events` | 회차 전체 감독 이벤트 (시간순, `participantId` 포함). 콘솔이 대상자마다 따로 부르지 않게 |
| GET | `/api/console/sessions/{id}/participants/{pid}/events` | 대상자 한 명의 감독 이벤트 (판정 포함) |
| PUT | `/api/console/sessions/{id}/events/{eid}/review` | 담당자 판정 `{review: "OK"\|"SUSPECT"\|null, note}`. `null` 이면 판정을 지움. 판정자(`reviewedBy`)는 로그인한 사람 |
| GET | `/api/console/sessions/{id}/events/{eid}/snapshot` | 사진 (image/jpeg, no-store) |
| GET | `/api/console/sessions/{id}/results` | 순위·분포·역량별 평균·상하위 비교·감독 합계·지표 |
| GET | `/api/console/sessions/{id}/results.csv` | CSV (UTF-8 BOM, 수식 주입 방지) |

### 3-1. 관리자 과제 콘솔

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/console/tasks` | 관리자: 모든 과제와 공개 상태. 매니저: 공개(OPEN) 과제만 (회차 만들 때 고르는 목록) |
| GET | `/api/console/tasks/{taskId}` | 과제 정의 + 공개 상태 (관리자) |
| POST | `/api/console/tasks/{taskId}/publish` · `/hide` | 공개(HIDDEN → OPEN) · 숨기기 (관리자). 처음 공개한 시각(`publishedAt`)은 남는다 |

회차에는 **OPEN 과제만** 걸 수 있다 (만들기·수정 모두 400). 과제 정의는 아직 classpath 파일이라 공개 상태만 `task_publications` 표에 둔다 (행이 없으면 HIDDEN).

---

## 4. 서버 쪽 필수 동작

| 동작 | 규칙 |
|---|---|
| 동시 시작 | 시작 가능 여부는 서버 시각으로만. 프론트 시계는 믿지 않는다 |
| 자동 제출 | 2초 주기 스케줄러가 `ends_at ≤ 지금` 이고 안 닫힌 회차를 찾아, 시작했고 미제출인 응시자를 전원 제출(`submit_kind=AUTO`). 회차마다 트랜잭션 분리, 두 번 돌아도 안전. 서버가 여러 대면 ShedLock 필요 |
| 종료 시 마무리 | 직접 제출해 후속 질문 단계에 있던 응시도 포함해, 시작한 응시자의 응시를 끝까지 넘긴다: 풀이 중이면 제출하고, 후속 질문 단계면 **빈 답으로 마무리해 채점 큐에 올린다**(안 하면 채점이 시작되지 않음). 이미 채점 단계인 응시는 건드리지 않는다 |
| 마무리 실패 재시도 | 채점으로 못 넘긴 응시가 있으면 회차를 닫지 않고 2초, 4초, 8초, 16초(최대 30초) 간격으로 다시 시도한다. 5번 실패하면 포기하고 닫으며 오류 로그를 남긴다. 재시도 상태는 서버 메모리에만 있다. 포기한 응시는 콘솔의 `rescue` 로 다시 넘긴다 |
| 지연 지표 | `closed_at - ends_at` 을 결과 API `metrics.autoSubmitLagMs` 로 |
| 사진 삭제 | 1시간 주기로 **회차 종료 30일**이 지난 사진 삭제 (`pair.exam.snapshot-retention-days`). S3 수명 주기 규칙으로 대신해도 된다 (그때도 `snapshot_deleted_at` 은 남길 것) |
| 초대 메일 | 대상자 등록·다시 보내기 트랜잭션 **커밋 뒤** 비동기 발송. 토큰 원문은 메모리 이벤트로만 메일러에 넘긴다. 결과는 `invite_status` (PENDING/SENT/FAILED). 결과 기록은 두 컬럼만 바꾸는 UPDATE 로 한다 (그 사이 응시자가 시작한 기록을 덮어쓰지 않게) |
| 하루 전 알림 | 5분 주기로 시작 24시간 안에 든 회차의 대상자에게 1번 (`reminded_at`). 초대 메일을 받은(SENT) 사람만, 시작 24시간 안에 초대된 사람은 건너뜀. 토큰 원문이 없으므로 링크 대신 "초대 메일의 링크" 안내 |
| 변경·취소 안내 | 수정·취소 트랜잭션 커밋 뒤 대상자 전원에게 비동기 발송 |
| 로그 | 초대 토큰이 경로에 들어가므로 접근 로그에서 가린다. 메일 주소도 로그에 남기지 않는다 |
| 브라우저 이벤트 | 감독 회차의 응시 화면은 탭·창 이탈, 마우스 이탈, 전체 화면 해제, **외부 붙여넣기(PASTE)** 를 1-7 로 함께 보낸다 (`source=BROWSER`, 사진 없음). 붙여넣기는 시험 화면 안에서 복사한 글이면 세지 않고, 20자 미만도 무시하며, 글 내용 대신 글자 수·줄 수·위치만 보낸다 |

## 5. 테이블

pAIr-back `backend/src/main/resources/db/migration/` 의 `V1__exam_sessions.sql`, `V2__exam_decisions.sql`, `V3__task_publications.sql` 참고:
`exam_sessions`, `exam_session_tasks`(+`task_usage`), `exam_participants`, `participant_attempts`, `proctor_consents`, `proctor_events`(+판정), `proctor_event_types`, `task_publications`

> `participant_attempts` 는 ERD 의 `attempts.participant_id` 를 대신한다. 응시(attempts)가 아직 파일(`pilot-data`)에 있어서, attempts 가 DB 로 옮겨질 때 없앤다.
