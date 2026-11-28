# 관리자 통계 API

관리자 콘솔에서 서비스 이용 현황을 보는 API다. 회원, 자가진단·실전 응시와 평균 점수(과제별 포함), AI 토큰·예상 비용, 크레딧 결제를 기간별로 모은다. 회원 목록 API 는 아래 [회원 목록](#회원-목록) 절.
관리자(ADMIN)만 부를 수 있고, 다른 역할은 403 이다. 모든 값은 저장된 기록을 집계해서 만든다(별도 집계 테이블 없음).

> 구현: pAIr-back `domain/stats` (`AdminStatsController`, `AdminStatsService`, `AdminStatsResponse`), 2026-11-28
> 레이팅·합격률은 아직 없다(레이팅은 나중에 추가 예정). 과제별 평균 점수·회원 목록은 2026-11-28 추가.

## 호출

```
GET /api/admin/stats?from=2026-11-01&to=2026-11-15
```

| 파라미터 | 형식 | 설명 |
| --- | --- | --- |
| `from` | `YYYY-MM-DD` (선택) | 시작일. 한국 시간 그날 0시부터 |
| `to` | `YYYY-MM-DD` (선택) | 종료일. 한국 시간 그날 끝까지 **포함** |

- 둘 다 없으면 오늘까지 최근 30일, 하나만 있으면 나머지를 30일 간격으로 채운다.
- 시작일이 종료일보다 늦거나, 기간이 366일을 넘거나, 날짜 형식이 틀리면 400 (`{"message": "..."}`).

## 응답

```json
{
  "from": "2026-11-01", "to": "2026-11-15",
  "members": { "users": 120, "companyMembers": 8, "companies": 3, "newUsers": 42, "withdrawn": 2 },
  "selfDiagnosis": {
    "started": 310, "submitted": 240, "scored": 236, "averageScore": 64.3,
    "bands": [ { "range": "0-39", "count": 30 }, { "range": "40-59", "count": 70 },
               { "range": "60-79", "count": 90 }, { "range": "80-100", "count": 46 } ],
    "tasks": [ { "taskId": "order-deadlock", "title": "주문 처리 장애 원인 분석", "scored": 150, "averageScore": 61.2 } ]
  },
  "live": {
    "sessions": 4, "participants": 55, "started": 98, "submitted": 95, "scored": 95, "averageScore": 58.2,
    "bands": [ ... ]
  },
  "ai": {
    "totalUsd": 18.42,
    "selfChat": { "calls": 2100, "inputTokens": 3100000, "outputTokens": 420000, "cachedTokens": 0, "usd": 6.1,
                  "models": [ { "model": "gpt-...", "calls": 2100, "inputTokens": 3100000, "outputTokens": 420000, "cachedTokens": 0, "usd": 6.1 } ] },
    "liveChat": { ... }, "scoring": { ... },
    "taskGen": { "jobs": 12, "calls": 140, "inputTokens": 900000, "outputTokens": 120000, "cachedTokens": 50000, "usd": 4.3 },
    "unpricedModels": []
  },
  "credits": { "paidCount": 15, "paidKrw": 224850, "refundedCount": 1, "refundedKrw": 4990 }
}
```

## 항목별 기준

**지금 값**(기간과 상관없음)과 **기간 값**이 섞여 있다.

| 항목 | 종류 | 기준 |
| --- | --- | --- |
| `members.users` | 지금 | 탈퇴하지 않은 일반 회원(USER) 수 |
| `members.companyMembers` | 지금 | 탈퇴하지 않은 기업 계정(MANAGER·PROCTOR) 수 |
| `members.companies` | 지금 | 삭제하지 않은 회사 수 |
| `members.newUsers` | 기간 | 가입 시각(`users.created_at`)이 기간 안인 일반 회원 |
| `members.withdrawn` | 기간 | 탈퇴 시각(`users.deleted_at`)이 기간 안인 계정. 회사 삭제로 정리된 멤버 포함 |
| `selfDiagnosis.*`, `live.started/submitted/scored` | 기간 | **응시 시작 시각**(`attempts.started_at`)이 기간 안인 응시. 지운 응시(미제출 삭제)와 관리자 계정의 응시는 뺀다 |
| `live.sessions`, `live.participants` | 기간 | 회차 **시작 시각**이 기간 안이고 취소하지 않은 회차와 그 대상자 |
| `ai.selfChat`, `ai.liveChat` | 기간 | AI 답변을 만든 시각이 기간 안인 채팅. 비용이므로 관리자 응시도 포함 |
| `ai.scoring` | 기간 | 채점 시작 시각이 기간 안인 채점의 모델 호출 |
| `ai.taskGen` | 기간 | 만든 시각이 기간 안인 AI 과제 생성 작업과 그 호출 |
| `credits.paid*` | 기간 | 결제 완료 시각이 기간 안인 구매 (뒤에 환불됐어도 포함) |
| `credits.refunded*` | 기간 | 환불 완료 시각이 기간 안인 구매 |

- 실전의 `started/submitted/scored` 는 대상자 × 과제 단위 응시 수다(과제가 둘인 회차는 대상자 한 명이 2건).
- 10월 31일에 시작해 11월 1일에 제출한 응시는 10월 기간에 잡힌다(시작 시각 기준).

## 점수

- `scored`: 채점 리포트가 나온 응시 수(리포트 버전 2 이상, 총점 있음).
- `averageScore`: 채점 총점의 평균, 소수 첫째 자리. 리포트의 `total / max × 100` 으로 100점 만점으로 바꿔 평균한다(지금 루브릭은 만점 100점이라 총점 그대로). 채점된 응시가 없으면 `null`.
- `bands`: 점수 구간별 응시 수. `0-39`, `40-59`, `60-79`, `80-100` (하한 포함).
- `selfDiagnosis.tasks`: 자가진단 과제별 채점 수와 평균 점수. 채점이 많은 순. `taskId` 는 과제 코드(화면 주소의 ID), 지운 과제는 제목이 `(지운 과제)`. 응시 수는 사람 수가 아니라 응시 건수다.

## AI 비용

- 채팅·채점: 설정 단가(`pair.pricing`, 100만 토큰당 USD)로 계산한 추정치. 회차 AI 비용 카드(`GET /api/console/sessions/{id}/ai-cost`)와 같은 계산(`SessionAiCostService`)을 쓴다. 캐시 입력 토큰도 일반 입력 단가로 계산하므로 실제 청구액보다 같거나 크다(상한).
- 단가가 없는 모델은 그 줄의 `usd` 가 `null` 이고 `unpricedModels` 에 이름이 들어가며 합계에서 빠진다.
- 과제 생성: 작업마다 기록된 비용(`task_gen_jobs.cost_usd`)의 합. 토큰은 호출 기록(`task_gen_calls`)의 합.
- `totalUsd` = 자가진단 채팅 + 실전 채팅 + 채점 + 과제 생성.

## 회원 목록

```
GET /api/admin/members?role=ALL&q=김&page=0&size=20
```

| 파라미터 | 기본 | 설명 |
| --- | --- | --- |
| `role` | `ALL` | `ALL` 전체, `USER` 일반 회원, `COMPANY` 기업 계정(매니저·감독관), `ADMIN` 관리자. 다른 값은 400 |
| `q` | 빈 값 | 이름 또는 이메일 일부 (대소문자 무시) |
| `page` | 0 | 0부터 |
| `size` | 20 | 1~100. 넘으면 400 |

탈퇴한 계정은 보이지 않는다. 최근 가입 순이다.

```json
{
  "members": [
    { "id": 12, "name": "김자가", "email": "kim@example.com", "role": "USER", "status": "ACTIVE", "companyName": null,
      "joinedAt": "2026-11-20T03:00:00Z", "selfAttempts": 3, "selfSubmitted": 2, "averageScore": 82.4,
      "creditBalance": 170, "lastAttemptAt": "2026-11-27T05:00:00Z" }
  ],
  "page": 0, "size": 20, "totalElements": 1, "totalPages": 1
}
```

| 항목 | 설명 |
| --- | --- |
| `role` | `USER`, `MANAGER`, `PROCTOR`, `ADMIN` |
| `status` | `ACTIVE` 이용 중, `PENDING` 기업 계정 첫 로그인 전 |
| `companyName` | 기업 계정의 회사 이름 |
| `selfAttempts`, `selfSubmitted` | 자가진단 응시(시작) 수와 그중 제출 수. **전체 기간**, 지운 응시 제외 |
| `averageScore` | 채점된 자가진단 총점(0~100점) 평균. 통계와 같은 기준. 없으면 `null` |
| `creditBalance` | 크레딧 잔액. 일반 회원만, 관리자·기업 계정은 `null` |
| `lastAttemptAt` | 마지막 자가진단 시작 시각. 없으면 `null` |

회원별 값은 한 페이지의 회원 ID 로 한 번씩 모아 읽는다(회원마다 따로 조회하지 않는다).
