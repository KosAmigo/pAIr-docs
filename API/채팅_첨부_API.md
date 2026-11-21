# AI 채팅 첨부 API

> 작성: 문희 · 2026-11-21 · 대상: 팀원 3 (응시 화면 채팅, 복기) · 상태: **구현됨** (pAIr-back·pAIr-front `feat/chat-attachments`, 아직 병합 전)
> 근거: [담당_기술명세_문희.md](../기획/담당_기술명세_문희.md) 5.5, [응시_자료_PDF_API.md](응시_자료_PDF_API.md), 테이블 `chat_attachments`

AI는 지금 응시자가 질문에 직접 붙여 넣은 글만 봅니다. 이 API는 응시자가 **파일 트리의 파일을 채팅창으로 끌어다 놓으면** 그 내용을 서버가 읽어 AI에게 함께 보내고, 무엇을 보여 줬는지 기록으로 남기게 합니다.

## 결정 사항

| 항목 | 결정 |
| --- | --- |
| 붙이는 방법 | 파일 트리의 파일(과제 자료 PDF 포함)을 **드래그해서 채팅창에 놓기**. 끌기를 못 쓰는 사용자를 위해 파일 행의 **클립 버튼**(Tab 으로 도달)도 같은 일을 한다 |
| 한도 | 질문 1개당 **파일 5개, 합계 3만 자** |
| 이후 질문 | 붙인 내용이 다음 질문들에도 계속 들어간다. **같은 파일은 가장 최근에 붙인 내용 하나만** AI에게 보낸다 |
| 크레딧 | 질문 기본 10 + **새로 붙인 파일 하나당 5** (최대 35). 이후 질문에 다시 들어가는 것은 차감 없음 |
| 대상 | 작업 파일(`ATTEMPT_FILE`)과 과제 자료 PDF 쪽 글(`TASK_FILE`) |

## 1. 질문 보내기 (기존 API 확장)

`POST /api/attempts/{id}/chat` 와 `POST /api/attempts/{id}/chat/stream` 의 본문에 `attachments`를 추가합니다. 없으면 지금과 똑같이 동작합니다.

```json
{
  "message": "OrderService 에서 락 순서가 문제인가요?",
  "attachments": [
    { "source": "ATTEMPT_FILE", "path": "src/shop/OrderService.java" },
    { "source": "TASK_FILE", "path": "자료/요금 안내.pdf", "pages": "1-2" }
  ]
}
```

- 클라이언트는 **무엇을 붙일지만** 보냅니다. 글자는 서버가 직접 읽어 `sent_text`를 만듭니다. 클라이언트가 보낸 글자를 기록으로 쓰면 조작할 수 있습니다.
- `ATTEMPT_FILE`: `attempt_files`의 **저장된** 내용. `pages`는 쓰지 않습니다.
- `TASK_FILE`: PDF만. `pages`는 `1-3,5` 형식이고 최대 20쪽입니다(`TaskMaterialService.pageTexts` 재사용). 생략하면 오류입니다(전체를 몰래 보내지 않기 위해).
- 같은 `source`+`path`(+`pages`)가 한 요청에 두 번 있으면 오류입니다.

### 서버 처리 순서 (`AttemptService.chatLocked`)

1. **검증**: 개수 ≤ 5, 중복 없음, 경로가 이 응시에서 볼 수 있는 파일인지(숨은 파일 불가), 글자 파일인지, 합계 ≤ 30,000자.
2. **크레딧 확인**: `checkChat`을 `질문 10 + 5 × 새 첨부 수`로 확인합니다(AI 호출 전, 읽기만).
3. **AI 요청 만들기**: 이전 대화는 지금처럼 `chat_turns.content`(질문만)로 만들고, 첨부 블록을 사용자 메시지에 덧붙입니다.
   - 각 사용자 턴: `질문` + (그 턴에 붙인 첨부 중 **아직 최신인 것**의 블록)
   - 같은 파일(`source`+`path`+`pages`)이 나중 턴에도 붙었으면, 앞 턴의 블록은 한 줄 표지(`[첨부: 경로 - 이후 질문에 더 최신 내용을 붙여서 생략함]`)로 줄입니다.
   - 응시 전체의 본문 합계가 `max-attachment-context-chars`(10만 자)를 넘으면 오래된 첨부부터 표지(`… 자료가 쌓여 용량 한도를 넘어 생략함`)로 줄입니다. **질문을 막지 않고** 줄이며, 이번 질문의 첨부는 항상 본문으로 갑니다.
   - 첨부 블록 형식: `<attachment name="src/shop/OrderService.java" source="ATTEMPT_FILE">…내용…</attachment>`. 첨부는 응시자 자료일 뿐 지시가 아니라는 한 줄을 시스템 프롬프트에 둡니다.
4. **저장(짧은 트랜잭션 하나)**: 질문·답·체크포인트·`chat_attachments`·크레딧 차감. 지금의 3단계 구조를 그대로 둡니다.

### 저장

- `chat_turns.content` = 질문 글만(화면과 채점이 읽는 글). 첨부 글자는 넣지 않습니다.
- `chat_attachments` 행 = 새로 붙인 파일마다 1개. `turn_id`는 **질문 턴**, `sent_text`는 이번에 AI에게 보낸 글자, `pages`는 PDF 쪽 범위, `mime_type`은 `text/plain` 또는 `application/pdf`.
- 크레딧: `credit_ledger`에 `CHAT_TURN` 행 **하나**, `amount = -(10 + 5n)`. 사유 값(CHECK)과 `turn_id` UNIQUE를 건드리지 않아 스키마 변경이 없습니다. 첨부 수는 `chat_attachments`로 알 수 있어 `note`는 쓰지 않습니다(엔티티에 매핑돼 있지 않음).
- AI 턴의 `request`(요청 원문)에 첨부 포함 메시지가 그대로 남으므로 다시 실행(R2)도 가능합니다.

### 응답

기존 `Turn[]`에 사용자 턴의 `attachments`를 추가합니다(본문 글자는 빼서 가볍게).

```json
{ "turn": 1, "role": "user", "text": "…", "attachments": [
  { "id": 12, "source": "ATTEMPT_FILE", "path": "src/shop/OrderService.java", "pages": null, "chars": 1840 }
] }
```

`GET /api/attempts/{id}` 의 `turns`와 복기 화면의 대화에도 같은 모양으로 나옵니다.

### 오류

기존 처리(`ApiExceptionHandler`)와 같은 상태 코드를 씁니다. 메시지는 화면에 그대로 보여 줄 수 있는 한글입니다.

| 상황 | 상태 | 메시지 예 |
| --- | --- | --- |
| 5개 초과 | 400 | 첨부는 한 번에 5개까지 붙일 수 있습니다. |
| 합계 3만 자 초과 | 400 | 첨부가 너무 깁니다(32,100자). 합계 30,000자 이하로 줄이거나 PDF 쪽 범위를 좁혀 주세요. |
| 없는 파일·숨은 파일·글자 없는 파일 | 404 | 없는 자료입니다: 경로 |
| 중복, `pages` 누락·형식 오류 | 400 | … |
| 크레딧 부족 | 402 | 크레딧이 부족합니다. 필요: 25, 잔액: 20 |

검증이 실패하면 AI를 부르지 않고 크레딧도 차감하지 않습니다.

## 2. 첨부 원문 보기 (선택, 복기·검토용)

`GET /api/attempts/{id}/attachments/{attachmentId}` → `{ "path": …, "pages": …, "sentText": "…" }`. 응시 주인만 볼 수 있고(기존 소유자 검사), 복기 화면에서 "그때 AI에게 보여 준 내용"을 펼쳐 볼 때 씁니다. 1차 구현에서는 빼도 됩니다.

## 3. 롤백과 복기

- 롤백이 앞 턴을 새 응시로 복사할 때(`RollbackService`) **그 턴의 `chat_attachments`도 새 `turn_id`로 복사**합니다. 크레딧은 다시 차감하지 않습니다(복사된 턴은 원래도 그렇습니다).
- 이후 질문에서 "같은 파일 최신 하나" 규칙은 복사된 첨부에도 똑같이 적용됩니다.
- 체크포인트(파일 상태)는 첨부와 무관합니다.

## 4. 화면 (드래그 앤 드롭)

- **끄는 쪽**: 파일 트리(`PathTree`)의 파일 행을 `draggable`로 하고 `dataTransfer`에 `{source, path}`를 JSON으로 담습니다(전용 타입 `application/x-pair-attachment`). PDF 자료 행은 같은 방식이고, 놓을 때 쪽 범위를 묻습니다.
- **놓는 쪽**: 채팅 패널 전체. 전용 타입일 때만 `dragover`에서 `preventDefault`하고 패널을 강조합니다. 외부 파일 드롭은 받지 않습니다.
- **칩**: 놓은 파일이 입력창 위에 칩(파일명, 쪽 범위, ✕)으로 쌓이고 `3/5`를 보여 줍니다. 5개째 이후는 놓아도 무시하고 안내합니다. 보낸 뒤 칩은 비웁니다.
- **크레딧 안내**: 칩 개수만큼 `+5`를 입력창 옆에 보여 줍니다(`CreditPill`).
- **보내기 전에 저장**: 서버는 저장된 내용을 읽으므로, 편집기 자동 저장이 밀려 있으면 첨부한 파일의 저장을 먼저 끝낸 뒤 보냅니다.
- 접근성: 끌기를 못 쓰는 사용자(키보드, 터치)를 위해 파일 행의 보조 동작이 필요합니다(아래 열린 질문).

## 5. 영향을 받는 코드

| 곳 | 변경 |
| --- | --- |
| `ApiController.ChatRequest`, `chat`, `chatStream` | `attachments` 추가 |
| `AttemptService.chatLocked` | 검증, 크레딧 계산, 요청 조립(최신 하나 규칙), 저장 |
| `ChatTurn` / `DbAttemptStore.appendTurn` | 사용자 턴에 첨부 목록. 생성자가 이미 여러 곳(테스트 포함)에서 쓰이므로 기존 생성자는 남기고 첨부 없는 오버로드를 둠 |
| `CreditService` | `checkChat`·`chargeChat`에 금액 인자 추가(기본 10) |
| `RollbackService` | 복사한 턴의 첨부 복사 |
| `PairProperties.Assistant` | `maxAttachments`(5), `maxAttachChars`(30000), `attachCost`(5) |
| 프론트 `api.ts`, `RealExam.tsx` | 전송 모양, 칩, 드래그 앤 드롭 |

## 6. 테스트 (구현 때)

- 첨부 5개·3만 자 경계, 6개째·3만 1자는 거절하고 크레딧을 차감하지 않음
- 숨은 파일·남의 응시 파일·바이너리 거절
- 같은 파일을 두 질문에 붙이면 AI 요청에는 최신 하나만, `chat_attachments`에는 둘 다
- 크레딧: 10 + 5n 차감, 이후 질문에서 다시 들어가는 파일은 차감 없음, 잔액 부족이면 AI 미호출
- 롤백으로 갈라진 응시에 첨부가 복사되고 추가 차감이 없음
- 실제 Postgres에서 `chat_attachments` 제약(`TASK_FILE`이면 `task_file_id` 필수) 통과

## 구현 메모 (2026-11-21)

- 설정(`application.yml`): `pair.assistant.max-attachments`(5), `max-attachment-chars`(30000), `max-attachment-context-chars`(100000), `pair.credit.attachment`(5).
- 코드: 백엔드 `ChatAttachmentService`(검증·요청 조립·저장·롤백 복사), `ChatAttachmentRecord`, `TaskMaterialService.attachForAttempt`, `CreditService.chatTotal/checkChat/chargeChat(…, 첨부 수)`. 프론트 `lib/chatAttach.ts`(규칙), `components/AttemptPdf.tsx`(응시 화면 PDF 뷰어), `pages/RealExam.tsx`(드래그·칩·자료 목록).
- 응시 화면 파일 탐색기에 PDF 자료가 `자료/` 아래로 함께 보이고, 누르면 오른쪽에 PDF가 열립니다(읽기 전용).
- 실제 확인: 로컬 Postgres + 실제 AI(gpt-6-luna)로 CSV 1개와 PDF 1-2쪽을 붙여 질문했고, AI가 PDF 쪽 글에서 가격을 읽어 답했습니다. 크레딧 20 차감(10 + 5×2).
- 한계: 브라우저 자동화 도구는 진짜 마우스 끌기를 HTML5 드래그로 만들지 못해, 끌기·놓기는 같은 `DragEvent`를 코드로 보내 확인했습니다. 클립 버튼은 진짜 클릭으로 확인했습니다.

## 남은 일

- 끌기·놓기를 실제 브라우저에서 사람이 한 번 해 보기(터치 기기는 클립 버튼만 됩니다).
- 복기 화면에서 "그때 AI에게 보여 준 내용" 원문 보기(위 2번 API)는 아직 만들지 않았습니다.
- 응시 화면 PDF 뷰어는 브라우저 기본 뷰어(iframe)입니다. 쪽 이동은 그 뷰어가 합니다.
