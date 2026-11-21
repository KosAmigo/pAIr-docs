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
  "tasks": [{ "taskId": "order-deadlock", "attemptId": null, "submitted": false }],
  "linkExpired": false
}
```
- `phase`: `UPCOMING`(시작 전) · `LIVE`(진행 중) · `ENDED`(종료) · `CANCELED`(취소됨, 입장·시작 불가) — 서버 시각 기준
- `linkExpired`: 시험을 시작한 뒤 연결 유예(5분)를 넘겨 입장 링크가 만료됐는지 (§1-9). 만료되면 같은 링크로 다시 들어올 수 없다
- 대기실 입장 마감은 없다 (한때 감독 회차에 시작 10분 전 마감을 뒀으나 2026-11-21 에 없앴다). 시작 전이면 언제든 입장해 대기할 수 있다
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
- **시작 시각이 지난 뒤 처음 입장해도** 종료 전이면 입장(`enter`)·동의·시작이 모두 된다 (입장 마감 없음). 종료 시각이 되면 `enter`·`start` 모두 400 "끝난 시험"
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
**응시자 PC** 가 올립니다. 휴대폰은 영상만 보내고, 책상 위 분석(물체 감지)은 PC 가 받은 휴대폰 영상으로 합니다. 휴대폰을 책상 전체가 한 화면에 보이는 위치에 고정한 상태에서 1.5초 간격 키프레임 사진을 올립니다(`stage: DESK`). 방 360도 스캔은 하지 않습니다(`ROOM`은 예전 데이터 호환용으로만 받습니다). 시험 시작 전 입장 단계에서 올립니다. 사전 테스트(`/practice`)에서는 올리지 않습니다.
```json
{ "stage": "DESK", "objects": ["cell phone", "book"], "image": "data:image/jpeg;base64,/9j/4AAQ..." }
```
| 필드 | 규칙 |
|---|---|
| `stage` | `DESK`(책상 위). `ROOM`(방 360도)은 더 이상 보내지 않지만 예전 기록 때문에 받는다 |
| `angle` | `ROOM` 사진의 방향 0~359. `DESK`는 비움 |
| `objects` | 사진에서 감지한 물체 이름, 최대 12개 |
| `image` | JPEG 만, 감독 사진과 같은 크기 한도 |
- 응답 `201`: `{id, participantId, stage, angle, objects[], phoneSuspect, sizeBytes, capturedAt, deleted}`. `objects` 에 `cell phone` 이 있으면 `phoneSuspect=true`.
- 감독을 쓰지 않는 회차, 취소된 회차, 종료 5분 뒤, 대상자당 100장 초과는 거절(400). 잘못된 링크는 404.
- 감독 이벤트(`proctor_events`)와 **따로** `env_scan_photos` 테이블에 저장해 이벤트 목록·통계에 섞이지 않습니다. 파일은 감독 사진과 같은 저장소(`env-scan/{회차}/{사진}.jpg`)에 올리고, 회차 종료 30일 뒤 파일만 지웁니다.
- 콘솔: `GET /api/console/sessions/{id}/participants/{pid}/env-scan`(목록), `GET /api/console/sessions/{id}/env-scan/{photoId}/image`(사진). 감독관도 볼 수 있습니다.
- **책상 위(`DESK`) 감지는 응시를 막지 않고 경고만 합니다.** 휴대폰·책·화면(노트북·모니터)이 잡히면 응시자 화면의 점검 결과에 "책상 위에서 휴대폰 2회가 감지되었습니다. 시험에 필요 없는 물건은 치워 주세요…" 경고(`warn`)가 뜨고, 응시자는 확인 창 없이 다음 단계로 넘어갑니다. 감독관은 콘솔의 "환경 점검 사진"("확인 필요" 표시)에서 사진과 물체 목록을 보고 판단합니다. 책상에서는 응시자 본인의 손·팔이 사람으로 잡혀 오탐이 나므로 `person` 은 세지 않습니다.
- 응시자가 점검을 다시 하면(통과하지 못한 항목만 다시 점검) 책상 스캔도 다시 하며 사진이 새로 올라갑니다. 이전 사진은 지우지 않고 감독관이 모두 볼 수 있습니다.
- 현재 프론트는 휴대폰 보조 캠 스위치(`PHONE_CAM_ENABLED=false`)를 꺼 두어 책상 위 사진이 올라오지 않는다. 스위치를 켜면 위 규칙대로 동작한다.

### 1-9. `POST /api/entry/{invite}/heartbeat` 시험 화면 연결 신호
시험 화면이 **10초마다** 보냅니다. 응답: `{ "expired": false }`.
- 시작 전·제출 후·종료된 시험·시작하지 않은 응시자의 신호는 무시하고, 이미 만료됐는지만 돌려줍니다.
- 신호가 **90초 넘게** 끊겼다 돌아오면 감독 이벤트 `CONNECTION_LOST`(끊긴 초를 `detail.gapSeconds` 에)를 남깁니다.
- 마지막 신호 뒤 **5분(유예)** 안에 돌아오지 못하면 입장 링크를 만료시키고 `LINK_EXPIRED` 를 남깁니다. 이때 응답은 `expired: true`, 입장 정보의 `linkExpired` 도 `true` 입니다. 재입장(`enter`) 때도 같은 규칙으로 막습니다.
- 돌아오지 않는 경우도 30초 주기 점검(`ConnectionGrace.expireAbsent`)이 만료와 `LINK_EXPIRED` 를 남깁니다. 두 이벤트는 자동 탈락이 아니라 담당자가 보는 기록입니다.
- 프론트의 연결 필수 규칙(웹캠·휴대폰·PC 화면 공유 15초 유예, 응시 화면 차단)은 서버와 별개로 응시자 화면에서 동작합니다 (명세서 §5.10).

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
| `startedAt` | 이상 상태가 시작된 시각. PC 시계가 조금 틀려도 버리지 않는다: 시작 시각 앞·서버 현재 시각 뒤로 어긋난 값은 가장자리로 맞춰 저장하고, `startsAt - 5분` ~ `서버 시각 + 5분` 밖이면 400 |
| `clientId` | 선택, 브라우저가 이벤트마다 만든 고유값(UUID, 8~36자 영숫자·`-`). 같은 값으로 다시 보내면 이벤트를 또 만들지 않는다 |
| `durationMs` | 0 ~ 3,600,000 |
| `confidence` | 선택, 0~1 |
| `detail` | 선택, 자유 JSON (최대 4,000자) |
| `snapshot` | 선택, JPEG data URL 또는 base64. **카메라 이벤트만**, 최대 200KB, JPEG 매직(FF D8 FF) 확인 |

- 시작하지 않은 응시자, 감독 없는 회차, 종료 30분이 지난 뒤의 요청은 400 (연결이 끊겼던 브라우저가 몰아서 보내는 이벤트를 위해 종료 뒤 30분까지 받는다)
- 사진은 S3 `exam-snapshots/{회차ID}/{이벤트ID}.jpg` (SSE-S3, 비공개 버킷, 회차 종료 30일 뒤 삭제). 키에 이벤트 번호가 들어 있어 이벤트와 사진이 항상 짝이 된다
- **저장은 세 단계로 나눈다**(작은 서버·적은 DB 연결에서도 버티게): ① 짧은 트랜잭션으로 이벤트 저장·커밋 ② 트랜잭션 밖에서 사진 업로드 ③ 이벤트에 사진 위치만 UPDATE. 업로드 중에 DB 연결을 쥐지 않는다
- **업로드가 실패하면 5xx 로 응답**하고, 프론트 아웃박스가 같은 `clientId` 로 다시 보낸다 (네트워크 오류·5xx 만 재시도, 4xx 는 버림). 다시 온 요청은 이미 저장된 이벤트를 찾아 **이벤트를 또 만들지 않고 사진만 올려 같은 이벤트에 연결**한다. `clientId` 가 없는 옛 클라이언트는 업로드 실패 시 이벤트도 되돌린다
- 대상자 한 명에게 붙는 사진은 최대 300장이다. 넘으면 이벤트는 저장하고 사진만 받지 않는다 (저장 공간 보호)
- 응답 201: `{ "id": 12, "type": "NO_FACE", "source": "PC_CAM", "startedAt": "...", "durationMs": 2100, "confidence": 0.91, "detail": "{...}", "snapshot": "ok", "snapshotBytes": 14203, "review": null, "reviewNote": null, "reviewedBy": null, "reviewedAt": null }`

**이벤트 유형** (DB 코드표 `proctor_event_types`: 경고 문구·심각도 LOW/MEDIUM/HIGH)

| type | source | 뜻 |
|---|---|---|
| `TAB_HIDDEN` `WINDOW_BLUR` `MOUSE_LEAVE` `PASTE` `FULLSCREEN_EXIT` | BROWSER | 탭·창 이탈, 외부 붙여넣기, 전체 화면 해제 |
| `NO_FACE` `MULTI_FACE` `HEAD_TURN` `HEAD_DOWN` `GAZE_AWAY` `TORSO_SHIFT` `TORSO_TURN` | PC_CAM | 얼굴 없음, 여러 얼굴, 고개 돌림, 오래 숙임, 시선 이탈, 자리 이동, 몸 돌림 |
| `HAND_MISSING` `PHONE` `EXTRA_SCREEN` `BOOK` | PHONE_CAM | 양손이 화면 밖으로 벗어남(3초), 휴대폰, 다른 화면, 책. `HAND_MOVED`·`ARM_MOVE`는 더 이상 보내지 않지만 예전 기록 때문에 받는다 |
| `PHONE_DISCONNECTED` | PHONE_CAM | 휴대폰 캠 연결 끊김·응답 없음·화면 이탈 (**릴레이 서버가 만든다**) |
| `CONNECTION_LOST` `LINK_EXPIRED` | BROWSER | 시험 화면 연결이 90초 넘게 끊겼다 돌아옴, 유예(5분) 안에 돌아오지 않아 링크 만료 (**서버가 §1-9 에서 만든다**, 요청으로는 받지 않는다) |

> 브라우저 이벤트(`TAB_HIDDEN` `WINDOW_BLUR` `MOUSE_LEAVE` `FULLSCREEN_EXIT` `PASTE`)도 이 API(1-7)로 `source=BROWSER`, 사진 없이 보낸다. 응시 화면의 `anti-cheating` 이 감지한 신호를 `proctor/core/events.ts` 의 `toBrowserViolation` 이 같은 이벤트 형식으로 바꾼다.
> 화면 공유 이벤트(`SCREEN_STOPPED` `SCREEN_PARTIAL`)와 `source=SCREEN` 은 **아직 받지 않는다**. 프론트는 `SCREEN_EVENTS_ACCEPTED=false` 로 전송을 막아 두었다 (§6-6).

---

## 2. 휴대폰 보조 캠 릴레이 (WebSocket `/ws/proctor`)

> **현재 상태(2026-11-21):** 프론트 스위치(`proctor/features.ts` 의 `PHONE_CAM_ENABLED`·`SCREEN_SHARE_ENABLED`)가 둘 다 `false` 라서 응시 흐름은 웹캠만 쓴다. 이 절의 릴레이와 §6-11 감독관 영상(휴대폰·화면 채널)은 스위치를 켰을 때의 동작이다.

PC 와 휴대폰을 잇는다. **이 WebSocket 으로는 영상이 오가지 않는다.** 휴대폰 영상은 `rtc` 메시지(시그널링)로 맺은 WebRTC 연결로 PC 에 직접 가고, 서버에 저장되지 않는다 (§2-5). 메시지는 모두 JSON 문자열. 최대 2MB.

### 2-1. 연결 순서
```
PC  ── hello-pc {invite} ─────────────▶ 서버: 초대 토큰 확인, 짝 코드 발급
PC  ◀── paired {pairCode, phoneUrl} ──  서버   (PC 는 phoneUrl 을 QR 로 보여 줌)
폰  ── hello-phone {pairCode} ────────▶ 서버: 짝 코드 확인
폰  ◀── phone-joined                    PC ◀── peer {phone:"connected"}
폰  ── phone-alert / phone-status / heartbeat ─▶ 서버 ─▶ PC   (rtc 는 §2-5)
```
- **휴대폰은 영상만 보내고 분석하지 않는다.** 손·휴대폰·책·다른 화면 분석과 책상 스캔은 모두 응시자 PC 가 받은 휴대폰 영상으로 한다 (`proctor/phoneAnalysis.ts`, `check/deskScan.ts`). 그래서 휴대폰의 이벤트·점검 사진·점검 결과(`violation`·`scan-frame`·`check-report`)는 이 WebSocket 으로 오가지 않는다. 휴대폰 이벤트는 PC 가 자기 아웃박스에서 §1-7 로 `source=PHONE_CAM` 으로 저장한다.
- 사전 테스트(`/practice`)는 `hello-pc` 에 `practice: true` 와 `practice-` 로 시작하는 임의 키를 넣어 짝만 맺는다. 서버는 입장 토큰 확인과 이벤트 저장을 하지 않는다.
- **짝 코드는 초대 토큰과 다른 값**이다 (QR 에 초대 토큰을 넣지 않는다). 대상자당 하나, 재접속해도 같은 값
- 휴대폰 페이지 주소: `{프론트 주소}/proctor/phone?p={pairCode}` (카메라 때문에 HTTPS 필요)
- 같은 짝 코드로 폰이 새로 붙으면 예전 폰 연결은 끊는다

### 2-2. 클라이언트 → 서버
| type | 보내는 쪽 | 내용 | 서버 처리 |
|---|---|---|---|
| `hello-pc` | PC | `{ invite, practice? }` | 토큰 확인. 틀리면 `error` 후 종료. `practice` 면 확인·저장 없이 짝만 맺음 |
| `hello-phone` | 폰 | `{ pairCode }` | 짝 확인. 틀리면 `error` 후 종료 |
| `phone-alert` | 폰 | `{ violation: { id, kind, type, message, startedAt, ts, durationMs, detail? } }` (시각은 epoch ms). 폰이 직접 아는 알림(감독 화면을 벗어남)만 | **저장하지 않고** 사진 없이 PC 로 전달. PC 가 자기 아웃박스에 넣어 §1-7 로 저장 |
| `phone-status` | 폰 | `{ status: { sending, bytesSent, relay? } }` 1초마다. `sending`: 책상 스캔을 마치고 영상만 보내는 중. `relay`: 폰 쪽 릴레이 재연결 횟수·마지막 닫힘·타이머 최대 지연(끊김 진단용) | `sending` 이 켜진 뒤부터 응답 없음을 감시. 마지막 수신 시각 갱신, PC 로 전달 |
| `heartbeat` | 폰 | `{}` 1초마다. 웹 워커가 메인 스레드와 무관하게 보낸다 | 수신만으로 마지막 수신 시각을 갱신 (메인 스레드가 추론·인코딩으로 바빠도 연결이 살아 있음을 알림) |
| `rtc` | PC·폰 | `{ signal }` — §2-5 | 형식 검사 후 **반대편으로 그대로 전달** (영상은 서버를 지나지 않음) |

### 2-3. 서버 → 클라이언트
| type | 받는 쪽 | 내용 |
|---|---|---|
| `paired` | PC | `{ pairCode, phoneUrl }` |
| `phone-joined` | 폰 | `{}` |
| `peer` | PC | `{ phone: "connected" \| "disconnected" \| "stale" }` |
| `violation` | PC | **서버가 직접 만든** 이벤트(휴대폰 연결 끊김·응답 없음). 서버가 이미 저장했으니 PC 는 보여 주기만 한다 |
| `phone-alert` | PC | 폰이 보낸 알림 (사진 없이). PC 가 저장한다 |
| `phone-status` | PC | 폰이 보낸 그대로 |
| `rtc` | PC·폰 | 상대가 보낸 `{ signal }` 그대로 |
| `error` | 둘 다 | `{ message }` |

### 2-4. 서버가 직접 만드는 이벤트
- 폰 연결이 끊김 → `PHONE_DISCONNECTED`
- 폰이 영상을 보내는 중(`sending=true`)인데 **15초** 동안 아무 메시지가 없음 → `peer: stale` + `PHONE_DISCONNECTED` (`PHONE_STALE_MS`, 개발 릴레이 `server/phoneStale.ts`). 처음에는 6초였으나, 아이폰 CPU 추론이 메인 스레드를 8~20초 잡아 연결이 멀쩡한데도 stale 이 반복돼 15초로 늘렸다. 실제 화면 꺼짐·앱 전환은 휴대폰 알림(`phone_hidden`)이 즉시 알린다
- 둘 다 응시자가 시작한 뒤에만 저장한다 (시작 전 점검 중 끊김은 기록 안 함)
- 사전 테스트 짝은 저장하지 않는다. 릴레이 진단 로그는 서버 PC 의 `%TEMP%\pair-relay.log` 에 남는다 (연결 번호·닫힘 코드·신호 간격)

### 2-5. 휴대폰 영상 (WebRTC 시그널링)
폰이 영상을 보내는 쪽(offer), PC 가 받는 쪽(answer)이다. 같은 와이파이가 아니어도 된다 (STUN, 막힌 망은 TURN).
```
PC  ── peer {phone:"connected"} 를 받으면 ── rtc {signal:{kind:"request"}} ─▶ 폰
폰  ── rtc {signal:{kind:"offer", sdp}} ────────────────────────────────▶ PC
PC  ── rtc {signal:{kind:"answer", sdp}} ───────────────────────────────▶ 폰
양쪽 ── rtc {signal:{kind:"candidate", candidate:{candidate,sdpMid,sdpMLineIndex,usernameFragment}}} ─▶ 상대
```
- `signal.kind` 는 `request | quality | torch | offer | answer | candidate` 만 허용한다. sdp 는 최대 32,000자, candidate 문자열은 최대 2,000자. 그 밖의 값은 버린다
  - `quality { mode: 'watch' | 'scan' }` (PC → 폰): 송신 화질 전환. 평소(`watch`)는 최대 1.2Mbps·15fps, 책상 스캔 동안(`scan`)만 최대 3.5Mbps 로 올려 작은 물체를 보이게 하고, 끝나면 되돌린다
  - `torch { on }` (PC → 폰): 조명이 어두울 때 휴대폰 손전등 요청 (안드로이드 크롬만 지원)
- 서버는 `rtc` 를 해석하지 않고 반대편(PC↔폰)으로만 넘긴다. 상대가 없으면 버린다
- 휴대폰은 책상 스캔부터 시험 중 감독까지 **후면 카메라를 그대로** 쓴다(전·후면 전환 없음). PC 는 연결이 `failed` 가 되면 2초 뒤 `request` 를 다시 보낸다 (최대 3회)
- ICE 서버: 프론트 환경변수 `VITE_TURN_URL`(쉼표로 여러 개), `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL`. 기본은 공개 STUN 만 쓴다. 학교·회사 망까지 지원하려면 TURN 이 필요하다
- 다른 네트워크의 폰이 붙으려면 `phoneUrl` 이 공인 HTTPS 주소여야 한다. 개발 릴레이는 `PAIR_PUBLIC_ORIGIN` 환경변수로 지정한다

> 개발용 릴레이: pAIr-front `frontend/server/proctorRelay.ts` (Vite 개발 서버 플러그인). 위 규칙을 구현했고, **서버가 만드는 이벤트(`PHONE_DISCONNECTED`)만** 백엔드 1-7 로 저장한다. 운영 릴레이(Spring WebSocket)는 **아직 없다** — 개발 릴레이와 같은 동작을 만들어야 한다. `pAIr-front/scripts/dev-all.mjs` 가 터널·백엔드·프론트를 함께 띄운다.

---

## 3. 기업 콘솔 API (콘솔 화면이 `frontend/src/consoleApi.ts` 로 부른다)

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
| POST | `/api/console/sessions/{id}/participants/csv?dryRun=` | 대상자 파일(**.csv 또는 .xlsx**, 2MB, 최대 1,000명) 업로드. 첫 행 `이름,이메일`. CSV 는 UTF-8(BOM 가능)·MS949 모두 읽음. `dryRun=true` 면 저장 없이 미리 보기(`added` = 등록될 인원). 저장하면 원본을 `participant-csv/{회차}/{업로드 ms}.csv` 에 보관(`participants_csv_key`). 틀린 행 하나 때문에 전체를 거절하지 않음 |
| GET | `/api/console/sessions/participants-template.csv` | 대상자 CSV 양식 내려받기 |
| GET | `/api/console/sessions/participants-template.xlsx` | 꾸민 엑셀 양식 (기본 양식) |
| DELETE | `/api/console/sessions/{id}/participants/{pid}` | 명단에서 빼기 (시작 전 회차, 입장 전 대상자만) |
| POST | `/api/console/sessions/{id}/participants/{pid}/invite` | 초대 메일 다시 보내기 (**새 토큰 발급, 이전 링크 무효**) |
| GET | `/api/console/sessions/{id}/events` | 회차 전체 감독 이벤트 (시간순, `participantId` 포함). 콘솔이 대상자마다 따로 부르지 않게 |
| GET | `/api/console/sessions/{id}/participants/{pid}/events` | 대상자 한 명의 감독 이벤트 (판정 포함) |
| PUT | `/api/console/sessions/{id}/events/{eid}/review` | 담당자 판정 `{review: "OK"\|"SUSPECT"\|null, note}`. `null` 이면 판정을 지움. 판정자(`reviewedBy`)는 로그인한 사람 |
| GET | `/api/console/sessions/{id}/events/{eid}/snapshot` | 사진 (image/jpeg, no-store) |
| GET | `/api/console/sessions/{id}/results` | 순위·분포·역량별 평균·상하위 비교·감독 합계·지표 |
| GET | `/api/console/sessions/{id}/participants/{pid}/env-scan` | 대상자의 환경 점검 사진 목록 (§1-8, 감독관도 볼 수 있다) |
| GET | `/api/console/sessions/{id}/env-scan/{photoId}/image` | 환경 점검 사진 (image/jpeg) |
| GET | `/api/console/sessions/{id}/results.csv` | CSV (UTF-8 BOM, 수식 주입 방지) |
| GET | `/api/console/sessions/{id}/results.xlsx` | 엑셀 결과 (관리자·매니저) |

### 3-1. 관리자 과제 콘솔

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/console/tasks` | 관리자: 모든 과제와 상태·용도. 매니저: 공개(OPEN)한 실전(LIVE) 과제만 (회차 만들 때 고르는 목록) |
| GET | `/api/console/tasks/{taskId}` | 과제 정의 + 상태 (관리자) |
| POST | `/api/console/tasks/{taskId}/publish` · `/hide` | 공개(HIDDEN → OPEN) · 숨기기 (관리자). 처음 공개한 시각(`publishedAt`)은 남는다 |
| PATCH | `/api/console/tasks/{taskId}/usage` | 검수 전(HIDDEN) 원본 과제의 용도(SELF/LIVE) 바꾸기. 공개한 과제·실전 복사본은 409 |
| GET | `/api/console/tasks/{taskId}/files` · `/questions` | 검수용: 모든 파일(숨은 파일 포함), 문항과 정답·근거 (관리자) |
| GET | `/api/console/tasks/{taskId}/materials` · `/materials/file` · `/materials/pages` | 검수용 PDF 자료 목록·원본·페이지 텍스트 (관리자) |

회차에는 **OPEN + LIVE 과제만** 걸 수 있다 (만들기·수정 모두 400). 과제 정의와 공개 상태는 DB(`tasks.status`, `tasks.usage`)에 있다. 이전에 쓰던 `task_publications` 표와 파일 기반 과제는 없어졌다. 이 API 의 구현은 `com.pair.taskconsole` 패키지다.

---

## 4. 서버 쪽 필수 동작

| 동작 | 규칙 |
|---|---|
| 동시 시작 | 시작 가능 여부는 서버 시각으로만. 프론트 시계는 믿지 않는다 |
| 자동 제출 | 2초 주기 스케줄러가 `ends_at ≤ 지금` 이고 안 닫힌 회차를 찾아, 시작했고 미제출인 응시자를 전원 제출(`submit_kind=AUTO`). 회차마다 트랜잭션 분리, 두 번 돌아도 안전. 서버가 여러 대면 ShedLock 필요 |
| 종료 시 마무리 | 직접 제출해 후속 질문 단계에 있던 응시도 포함해, 시작한 응시자의 응시를 끝까지 넘긴다: 풀이 중이면 제출하고, 후속 질문 단계면 **빈 답으로 마무리해 채점 큐에 올린다**(안 하면 채점이 시작되지 않음). 이미 채점 단계인 응시는 건드리지 않는다 |
| 마무리 실패 재시도 | 채점으로 못 넘긴 응시가 있으면 회차를 닫지 않고 2초, 4초, 8초, 16초(최대 30초) 간격으로 다시 시도한다. 5번 실패하면 포기하고 닫으며 오류 로그를 남긴다. 재시도 상태는 서버 메모리에만 있다. 포기한 응시는 콘솔의 `rescue` 로 다시 넘긴다 |
| 지연 지표 | `closed_at - ends_at` 을 결과 API `metrics.autoSubmitLagMs` 로 |
| 사진 삭제 | 1시간 주기로 **회차 종료 30일**이 지난 감독 사진과 환경 점검 사진(`env_scan_photos`)을 삭제 (`pair.exam.snapshot-retention-days`). S3 수명 주기 규칙으로 대신해도 된다 (그때도 `snapshot_deleted_at`·`deleted_at` 은 남길 것) |
| 연결 유예 | 시작한 응시자의 시험 화면이 10초마다 `heartbeat`(§1-9)를 보낸다. 90초 넘게 끊겼다 돌아오면 `CONNECTION_LOST`, 마지막 신호 뒤 5분 안에 못 돌아오면 링크 만료와 `LINK_EXPIRED`. 30초 주기 점검이 돌아오지 않는 응시자도 만료시킨다 (이미 다 제출한 응시자는 제외) |
| 초대 메일 | 대상자 등록·다시 보내기 트랜잭션 **커밋 뒤** 비동기 발송. 토큰 원문은 메모리 이벤트로만 메일러에 넘긴다. 결과는 `invite_status` (PENDING/SENT/FAILED). 결과 기록은 두 컬럼만 바꾸는 UPDATE 로 한다 (그 사이 응시자가 시작한 기록을 덮어쓰지 않게) |
| 하루 전 알림 | 5분 주기로 시작 24시간 안에 든 회차의 대상자에게 1번 (`reminded_at`). 초대 메일을 받은(SENT) 사람만, 시작 24시간 안에 초대된 사람은 건너뜀. 토큰 원문이 없으므로 링크 대신 "초대 메일의 링크" 안내 |
| 변경·취소 안내 | 수정·취소 트랜잭션 커밋 뒤 대상자 전원에게 비동기 발송 |
| 로그 | 초대 토큰이 경로에 들어가므로 접근 로그에서 가린다. 메일 주소도 로그에 남기지 않는다 |
| 브라우저 이벤트 | 감독 회차의 응시 화면은 탭·창 이탈, 마우스 이탈, 전체 화면 해제, **외부 붙여넣기(PASTE)** 를 1-7 로 함께 보낸다 (`source=BROWSER`, 사진 없음). 붙여넣기는 시험 화면 안에서 복사한 글이면 세지 않고, 20자 미만도 무시하며, 글 내용 대신 글자 수·줄 수·위치만 보낸다 |

## 5. 테이블

pAIr-back `backend/src/main/resources/db/migration/` 의 `V1__erd_schema.sql`(ERD 기준 전체), `V2__erd_changes.sql`(초대 상태·`closed_at`·사진 크기·`received_at`), `V11__connection_grace.sql`(연결 유예), `V14__env_scan_photos.sql`(환경 점검 사진) 참고:
`exam_sessions`, `exam_session_tasks`(+`task_usage`), `exam_participants`(+`last_seen_at`, `link_expired_at`), `proctor_consents`, `proctor_events`(+판정), `proctor_event_types`(코드표, `CONNECTION_LOST`·`LINK_EXPIRED` 포함), `env_scan_photos`

> 예전의 `participant_attempts`·`task_publications` 는 없어졌다. 응시(attempts)와 과제가 DB 로 옮겨져 `attempts.participant_id` 로 대상자와 응시를 잇는다. 시작·제출 시각은 응시에서 계산한다(`ParticipantProgress`).

---

## 6. 제안(미구현): 영상 이벤트 서버 재확인

> **상태: 제안 (2026-11-21 확인).** 백엔드는 아직 구현하지 않았다. `server_check` 컬럼·재확인 큐·콘솔 응답 필드 모두 없다. 프론트(콘솔 배지, `proctor/core/serverCheck.ts`)는 필드가 없어도 정상 동작하므로 백엔드가 준비되는 대로 켜면 된다. 근거: pAIr-front `docs/intent/proctor-client-analysis.md`, `docs/plan/proctor-client-analysis-plan.md` 4단계.

### 6-1. 배경과 확정 사항
- 분석은 응시자 PC가 한다(웹캠·휴대폰 영상 모두). 영상 속 이벤트(PC_CAM·PHONE_CAM)는 PC가 감지하면 **사진 1장**을 §1-7 로 보낸다. 서버는 그 사진을 모델로 한 번 더 확인해 결과를 이벤트에 붙인다.
- 서버가 사진에서 못 찾은 이벤트는 **버리지 않고 "서버 미확인(UNCONFIRMED)"으로 기록**한다 (사용자 확정). 콘솔은 미확인을 숨기지 않고 우선 표시한다.
- 목표 규모: 한 회차 300명 이상. 서버는 영상을 받지 않고 이벤트 사진만 받는다.

### 6-2. 현재 상태 (pAIr-back 확인 결과)
| 항목 | 지금 | 근거 |
|---|---|---|
| 이벤트 저장 | `POST /api/entry/{token}/proctor-events` 가 동기로 이벤트 저장 + 사진 업로드(`SnapshotStorage.put`) 후 `201` | `ExamEntryController`, `ProctorService.record` |
| 사진 규칙 | 카메라 이벤트만(브라우저 이벤트에 붙이면 400), JPEG 검증 | `SnapshotValidator`, `record` |
| `source` | 요청의 `source` 는 받기만 하고, 저장·응답의 출처는 **`type` 이 정한다** (`Type.source()`). `Source` 열거형은 `BROWSER·PC_CAM·PHONE_CAM` 뿐 | `ProctorEvent.Type/Source` |
| 서버 확인 필드 | 없음 (엔티티·DTO·콘솔 응답 모두) | `ProctorEvent`, `ExamDtos.ProctorEventView` |
| 재확인 처리·큐 | 없음 | — |
| 화면 공유 | `SCREEN` 출처·유형 없음. 프론트는 `SCREEN_EVENTS_ACCEPTED=false` 로 전송을 막아 두었다 | pAIr-front `frontend/src/proctor/screen/screenContract.ts` |
| 분석 중단 감지 | 없음 (`PHONE_DISCONNECTED` 는 릴레이의 휴대폰 연결 감시) | §2-4 |

### 6-3. 제안 1: 서버 확인 상태 필드
`proctor_events` 에 컬럼 추가 (다음 Flyway 번호):

| 컬럼 | 타입 | 규칙 |
|---|---|---|
| `server_check` | `varchar(12) NULL` | `PENDING` · `CONFIRMED` · `UNCONFIRMED`. 재확인 대상이 아니면 **NULL** |
| `server_checked_at` | `timestamp NULL` | 재확인이 끝난 시각 (PENDING 일 때 NULL) |
| `server_check_detail` | `json NULL` | (선택) 모델이 본 것 `{ "model": "...", "found": ["person","cell phone"], "score": 0.82 }`. 오탐 분석용 |

- **재확인 대상**: `source` 가 `PC_CAM`·`PHONE_CAM` 이고, 사진이 붙어 있고, `type` 이 `PHONE_DISCONNECTED` 가 아닌 이벤트. 사진이 없거나 대상이 아니면 `NULL` 로 둔다 (PENDING 으로 두면 영원히 "확인 중"으로 보인다).
- **상태 전이**: 저장 시 `PENDING` → 비동기 재확인이 끝나면 `CONFIRMED`(모델이 같은 이벤트를 찾음) 또는 `UNCONFIRMED`(못 찾음). 한 번 정해지면 바뀌지 않는다. 같은 이벤트를 두 번 처리해도 결과가 같게(멱등) 한다.
- **재확인 실패(모델 오류·시간 초과·사진 삭제)**: 재시도 N회 뒤에도 안 되면 `UNCONFIRMED` + `server_check_detail.error` 로 마감한다. 사람이 봐야 한다는 뜻이라 안전한 쪽이다. 영원히 `PENDING` 으로 남기지 않는다 (예: 10분 넘은 PENDING 을 스케줄러가 `UNCONFIRMED` 로 마감).
- **`serverCheck` 는 판정이 아니다.** 담당자 판정(`review`)과 별개이며 자동 탈락 근거로 쓰지 않는다. `UNCONFIRMED` 는 "서버가 못 봤으니 사람이 확인하라"는 우선순위 표시다.

### 6-4. 제안 2: 비동기 재확인 (300명 동시 처리)
- `POST /proctor-events` 는 **지금처럼 저장하고 바로 `201`** 을 준다. 모델 호출을 이 요청 안에서 하지 않는다 (응시자 PC의 아웃박스가 이벤트를 하나씩 순서대로 보내므로, 응답이 느리면 뒤 이벤트가 밀린다).
- 저장 트랜잭션이 **커밋된 뒤** 재확인 작업을 큐에 넣는다 (`@TransactionalEventListener(AFTER_COMMIT)` 또는 outbox 테이블). 작업에는 `eventId` 만 담고, 사진은 `SnapshotStorage` 에서 읽는다.
- 워커는 결과를 `UPDATE ... SET server_check=?, server_checked_at=? WHERE id=? AND server_check='PENDING'` 로 쓴다 (멱등, 다른 컬럼을 덮어쓰지 않음. 그 사이 담당자 판정이 저장돼도 안전).
- 규모 가늠(가정, 측정 필요): 300명 × 이벤트 분당 1~3건이면 초당 5~15건, 몰릴 때(시험 시작 직후 등)는 몇 배. 모델 1건이 0.2~1초라면 워커 동시 처리 10~20개로 충분하다. 큐가 밀려도 `PENDING` 으로 보일 뿐 이벤트는 잃지 않는다.
- 사진 크기: 지금 프론트는 가로 320px JPEG(약 15~25KB)다. 서버 모델이 작은 물체(휴대폰·책)를 못 찾으면 해상도를 올려야 할 수 있다 (요청 최대 200KB). 모델 선택 뒤 같이 정한다.

### 6-5. 제안 3: 콘솔 응답 필드
`GET /api/console/sessions/{id}/events`, `.../participants/{pid}/events`, `PUT .../events/{eventId}/review` 의 `ProctorEventView` 에 두 필드를 **추가**한다 (기존 필드는 그대로). `server_check_detail` 은 노출하지 않거나 관리자에게만 보인다.

```json
{
  "id": 12, "participantId": 7, "type": "PHONE", "source": "PHONE_CAM",
  "startedAt": "2026-12-01T06:12:03.120Z", "durationMs": 2100, "confidence": 0.91,
  "detail": "{\"hands\":2,\"objects\":\"cell phone\"}",
  "snapshot": "ok", "snapshotBytes": 14203,
  "review": null, "reviewNote": null, "reviewedBy": null, "reviewedAt": null,
  "serverCheck": "UNCONFIRMED",
  "serverCheckedAt": "2026-12-01T06:12:05.480Z"
}
```
- 프론트 타입: `ProctorEventView.serverCheck?: 'PENDING'|'CONFIRMED'|'UNCONFIRMED'|null`, `serverCheckedAt?: string|null`. 필드가 없거나 `null` 이면 배지를 보여 주지 않는다. 모르는 값이 오면 배지 없이 무시한다.
- 콘솔은 폴링(`pollMs`)으로 목록을 다시 불러오므로 `PENDING → 확정` 은 다음 조회에 반영된다. 별도 푸시는 필요 없다.
- `POST /proctor-events` 응답도 같은 `ProctorEventView` 라 저장 직후엔 `PENDING`(대상이 아니면 `null`)이다. **요청 형식은 바꾸지 않는다.**

### 6-6. 제안 4: 화면 공유 사진 (`source=SCREEN`)
- `ProctorEvent.Source` 에 `SCREEN` 추가, `Type` 에 `SCREEN_STOPPED`(화면 공유 중단)·`SCREEN_PARTIAL`(전체 화면이 아닌 창·탭만 공유)을 `Source.SCREEN` 으로 추가. `type` 컬럼이 `varchar(20)` 이라 길이는 맞는다 (`SCREEN_STOPPED` 14자). `proctor_event_types` 코드표 행도 추가한다.
- 응시자 화면이 보내는 요청으로 받는다 (서버가 직접 만드는 유형이 아님). 사진은 선택이다 (중단 이벤트는 순간 화면이 없을 수 있다).
- **흐림 처리 위치**: 지금 프론트가 사진을 **보내기 전에 흐리게** 만든다 (`captureBlurred`).

| | 클라이언트에서 흐림 (현재) | 서버에서 흐림 |
|---|---|---|
| 개인정보 | 원본이 네트워크·서버에 한 번도 안 나간다 (가장 안전) | 원본이 서버를 거친다 |
| 변조 | 응시자가 흐림을 건너뛰고 글자가 읽히는 사진을 보낼 수 있다 | 서버가 강제할 수 있다 |
| 비용 | 서버 부하 없음 | 이미지 처리 부하 |

  **권고**: 클라이언트 흐림 유지(개인정보 최소화) + 서버는 형식·크기만 검사. 서버가 흐림 정도를 검증할 수 있으면(예: 고주파 성분 검사) 덧붙이되 필수는 아니다. 화면 사진은 **재확인(§6-3) 대상에서 제외**한다 (화면 내용 분석은 범위 밖).
- 백엔드가 받게 되면 프론트는 `screenContract.ts` 의 `SCREEN_EVENTS_ACCEPTED` 를 `true` 로 바꿔 전송을 켠다.

### 6-7. 제안 5: 분석 중단 감지
응시자가 분석을 끄거나 막는 것을 탐지하기 위한 제안이다 (완전한 방어는 아님. 계획 문서 위험 (e)).
- PC가 "분석 동작 중" 신호를 주기적으로 보낸다. 새 API 보다 기존 `heartbeat`(10초, §1) 를 확장하는 쪽을 권고한다: 요청 본문에 선택 필드 `{ "analysis": { "pc": true, "phone": true } }` (감시 중인데 해당 채널 분석 루프가 도는지).
- 서버는 응시 중인 참가자의 신호가 일정 시간(예: 30초) 없거나 `false` 가 이어지면 이벤트를 남긴다. 새 `Type` 예: `ANALYSIS_STOPPED`(서버가 직접 만드는 유형이라 `CONNECTION_LOST` 처럼 요청으로는 받지 않음). 복구되면 기록을 닫는다.
- 프론트 구현은 이 계약이 정해진 뒤 한다 (지금은 보내지 않음).

### 6-8. 재확인 모델·인프라 선택지
| | 자체 큐 워커 (별도 서비스에서 ONNX/PyTorch 등) | 클라우드 비전 API (예: AWS Rekognition, Google Vision) |
|---|---|---|
| 정확도 | 모델을 고르고 튜닝할 수 있다. 책·휴대폰 같은 항목을 직접 맞춤 | 일반 물체·사람 탐지는 좋지만 시선·고개·자세 같은 항목은 직접 지원이 제한적이라 이벤트별로 확인 가능 범위가 다르다 |
| 비용 | 사진이 적어(초당 수~십수 건) CPU 로도 가능. 인스턴스 고정비 | 호출당 과금. 규모가 작으면 가장 싸다. 300명 한 회차 기준으로 가늠 필요 |
| 운영 부담 | 모델 배포·버전·스케일링을 우리가 맡는다 | 운영 거의 없음 |
| 개인정보 | 사진이 우리 인프라 안에만 머문다 | 응시자 얼굴 사진이 외부 서비스로 나간다 → 동의서·처리방침·리전 확인 필요 |
| 지연·안정성 | 우리가 통제 | 외부 장애·요율 제한 영향. 재시도·백오프 필요 |
| 시작 속도 | 느림 (모델 준비) | 빠름 (API 연동) |

- **권고(합의 필요)**: 1차는 **자체 큐 워커**로 응시자 PC와 다른 모델·설정을 써서 "사진 속 사람 수·휴대폰·책·화면"만 재확인한다 (대상이 이 종류로 제한되고, 얼굴 사진이 외부로 나가지 않는다). 시선·고개·자세 이벤트는 **서버 재확인 대상에서 제외**(NULL)하고 사람이 사진으로 보는 쪽이 현실적이다. 클라우드 API 는 정확도 비교용으로 병행 평가할 가치가 있다. 어느 쪽이든 재확인 모듈은 인터페이스(예: `ServerRechecker`) 뒤에 두면 바꿀 수 있다.
- **합의가 필요한 결정**: ① 재확인 대상 이벤트 종류 ② 모델·인프라 ③ 재시도 횟수·PENDING 마감 시간 ④ 사진 해상도 ⑤ 콘솔에서 `UNCONFIRMED` 를 정렬·집계하는 방식 (프론트는 우선 표시).

### 6-9. 프론트가 이미 한 것
- 타입·배지·우선순위 순수 함수: pAIr-front `frontend/src/proctor/core/serverCheck.ts` (테스트 `tests/proctor/serverCheck.test.ts`). 감독관 콘솔(`ProctorPanel`)이 영상 이벤트(PC_CAM·PHONE_CAM)에만 "서버 확인 중 / 서버 확인됨 / 서버 미확인" 배지를 붙이고 머리글에 "서버 미확인 N건"을 보여 준다. 브라우저·화면 공유 이벤트와 연결 끊김에는 붙이지 않는다.
- 전송: 응시자 PC가 영상 이벤트마다 사진을 §1-7 `snapshot` 으로 붙여 보낸다. 사진이 안 붙는 경우는 ① 휴대폰 화면 이탈(`PHONE_DISCONNECTED`, 사진이 의미 없음) ② 영상 프레임이 아직 없을 때 ③ 브라우저 저장소가 가득 차 저장 복사본에서 사진을 뺀 경우(서버가 거절·재시도 중 새로고침하면 사진 손실)다. 이런 이벤트는 §6-3 대로 `NULL` 로 둔다.

### 6-10. 구현 뒤 확인할 것
1. `POST /proctor-events` 가 여전히 즉시 `201` 이고 응시자 PC 아웃박스가 밀리지 않는가 (재확인 지연이 요청에 섞이지 않았는가).
2. 사진 있는 PC_CAM·PHONE_CAM 이벤트가 `PENDING` → `CONFIRMED`/`UNCONFIRMED` 로 바뀌고, 사진 없는 이벤트·브라우저 이벤트는 `null` 인가.
3. 모델이 죽거나 시간이 넘어도 `PENDING` 이 남지 않고 `UNCONFIRMED` 로 마감되는가.
4. 같은 이벤트를 두 번 처리해도 상태가 안 바뀌는가 (멱등).
5. 콘솔 응답에 `serverCheck`·`serverCheckedAt` 이 와서 배지가 보이고, 필드를 뺀 응답에서도 화면이 정상인가.
6. 300명 동시 부하(이벤트 폭주)에서 큐 적체·워커 처리 속도·비용 측정.
7. 정확도: 실제 휴대폰·책·두 사람 사진으로 `CONFIRMED`/`UNCONFIRMED` 비율과 오탐·미탐 확인.

### 6-11. 제안 6: 감독관 실시간 영상 시그널링 (5단계)
> **상태: 프론트·개발 릴레이 구현 완료, 운영 백엔드 제안.** 프론트(응시자 송신 `proctor/relay/viewerSender.ts`, 감독관 시청 `proctor/watch/`·`pages/console/LiveWatch.tsx`)와 개발 릴레이 임시 구현은 끝났다 (`tests/proctor/viewer.test.ts`, `watchRelay.test.ts`). 운영 백엔드는 같은 메시지를 Spring WebSocket(`/ws/proctor`)으로 구현하면 된다. 근거: pAIr-front `docs/plan/proctor-client-analysis-plan.md` 5단계.

**원칙 (사용자 확정)**: 감독관이 그 응시자를 **열었을 때만** 휴대폰·웹캠·화면 공유 영상을 보낸다(상시 전송 없음). 감독관은 한 명씩만 본다. WebRTC P2P 로 충분하고 SFU 는 쓰지 않는다. **영상은 서버를 지나지 않고 저장하지 않는다** (서버는 시그널링만 넘긴다). 감독관이 안 보고 있어도 이벤트 감지·기록은 응시자 PC 가 계속한다.

**영상 경로**: 응시자 PC 가 감독관에게 직접 보낸다. 휴대폰 영상도 PC 가 이미 받은 스트림을 **그대로 다시 보낸다**(휴대폰이 감독관에게 직접 보내지 않는다 → 휴대폰 부하·전력 증가 없음, 휴대폰 연결 방식 변경 없음). 응시자 PC 는 감독관 1명 × 3채널 = 최대 3개 연결을 만들고, 채널별 상한 500kbps(화면은 400kbps, 4fps)로 묶는다.

| 방향 | type | 내용 | 서버 처리 |
|---|---|---|---|
| 감독관 → 서버 | `watch` | `{ sessionId, participantId }` | **권한 확인**, 그 응시자의 감독관 정원 확인, 응시자 PC 에 `viewer-request` ×3 |
| 감독관 → 서버 | `unwatch` | `{}` (연결이 끊겨도 같다) | 응시자 PC 에 `viewer-gone` |
| 서버 → 감독관 | `watch-state` | `{ state: "watching"\|"offline"\|"denied"\|"full"\|"error", message? }` | `offline`: 응시자 PC 가 연결돼 있지 않음 (다시 붙으면 `watching`) |
| 서버 → 응시자 PC | `viewer-request` | `{ viewer, channel: "phone"\|"webcam"\|"screen" }` | PC 는 그 채널의 영상 offer 를 보낸다 |
| 서버 → 응시자 PC | `viewer-gone` | `{ viewer }` | PC 는 그 감독관 전송을 모두 닫는다 |
| 감독관·PC 양쪽 | `view-rtc` | `{ channel, signal, viewer? }` signal: `offer`·`answer`·`candidate`·`request`(다시 보내 달라)·`unavailable`(그 채널은 보낼 영상 없음) | 형식 검사 후 **반대편으로 그대로 전달**. 감독관 → PC 는 서버가 `viewer` 를 붙이고, PC → 감독관은 PC 가 붙인 `viewer` 로 찾아 넘긴다 |

- `viewer` 는 서버가 감독관 연결마다 정하는 식별자(예: 연결 번호). 감독관 연결 하나는 한 응시자만 본다 (`watch` 를 다시 보내면 이전 대상을 닫는다).
- 응시자 PC 가 끊기면 서버는 보고 있던 감독관에게 `watch-state: offline` 을 보내고, PC 가 다시 붙으면 `watching` 과 `viewer-request` 를 다시 보낸다. 응시자 PC 는 릴레이가 끊기면 감독관 전송을 모두 닫는다.
- 신호 허용 값: `kind` 는 위 5개뿐, sdp 32,000자·candidate 2,000자 이하(§2-5와 같다). 감독관 경로로는 휴대폰 제어(`torch`·`quality`)가 통하지 않는다.
- **동시 시청 상한**: 응시자 1명당 `MAX_VIEWERS_PER_PARTICIPANT = 2` (프론트 `src/proctor/relay/watchRoom.ts` 한곳, 운영 백엔드도 같은 값으로 정원 초과 시 `watch-state: full`). 상한을 둔 이유는 응시자 PC 가 감독관마다 영상을 따로 인코딩하기 때문이다.

**백엔드가 해야 할 것 (권한)**
- `watch` 는 로그인한 감독관·매니저·관리자만, **자기 회사 회차의** 응시자만 열 수 있다 (콘솔 API 와 같은 규칙: 다른 회사 회차는 `denied`, 있는지도 알리지 않는다). WebSocket 연결의 로그인 정보(쿠키·Bearer 토큰)로 확인한다.
- 회차 `proctoring=true` 이고 진행 중(`LIVE`)이며 응시자가 입장했고 제출 전일 때만 연다.
- `sessionId + participantId` ↔ 응시자 PC 연결(입장 토큰)은 서버가 DB 로 안다. 콘솔은 입장 토큰을 모른다.
- 감독관이 열고 닫은 사실(누가, 누구를, 언제부터 언제까지)을 감사용으로 남기는 것을 권장한다 (영상은 저장하지 않지만 열람 기록은 남긴다).
- 응시자에게는 감독관이 보고 있다는 사실을 알린다 (프론트가 화면 공유 동의 문구에 안내를 넣었다. 보고 있는 감독관 수는 응시자 PC 가 안다).

**개발 릴레이의 임시 방식 (운영에서 쓰지 말 것)**: 개발 릴레이(`frontend/server/proctorRelay.ts`)는 감독관이 `watch` 에 실어 보낸 로그인 헤더(`X-Pair-*`, `Authorization`)로 백엔드 `GET /api/console/sessions/{id}` 를 불러 권한을 확인하고(401·403·404 → `denied`), 응답의 참가자 이메일·회차 이름이 같은 응시자 PC 연결을 그 응시자로 본다. 운영 백엔드는 이 우회가 필요 없다. 로그인 헤더를 메시지에 싣는 것도 개발 전용이다.

**구현 뒤 확인할 것**
1. 다른 회사 감독관·응시자 본인·로그인 없음이 `watch` 하면 `denied` 이고 응시자 PC 에 `viewer-request` 가 가지 않는가.
2. 감독관이 `unwatch` 하거나 연결이 끊기면(탭 닫기·네트워크 끊김) 응시자 PC 에 `viewer-gone` 이 가서 전송이 멈추는가.
3. 응시자 1명에 3번째 감독관이 `full` 을 받는가, 한 명이 나가면 다시 들어올 수 있는가.
4. 응시자 PC 재접속 시 감독관이 `offline` → `watching` 으로 돌아오는가.
5. 300명 회차에서 `view-rtc` 가 응시자 PC·감독관 사이에만 가고 다른 응시자에게 새지 않는가 (감독관 연결의 대상 고정 확인).
6. 서버·DB 어디에도 영상이 남지 않는가 (TURN 을 쓰면 중계만 하고 저장하지 않는다).
7. 열람 기록을 남기는 경우 열기·닫기 시각이 맞는가.
