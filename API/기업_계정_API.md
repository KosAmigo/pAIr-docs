# 기업 계정 API 명세

> 기준 구현: pAIr-back `backend/src/main/java/com/pair/domain/company/` 및 `backend/src/main/java/com/pair/domain/auth/`
> 기업 회원은 자체 가입하지 않는다. 도입 문의 승인 시 CSV 명단으로 계정을 만들고, 이후 매니저가 감독관을 초대한다.

## 공통 규칙

| 항목 | 규칙 |
|---|---|
| 인증 | 별도 표시가 없으면 HTTP `Authorization` 헤더에 로그인 Access Token 필요 |
| 오류 | HTTP 상태 코드와 `{"message":"사용자에게 표시할 문장"}` 형식. 인증 실패 401, 권한 부족 403, 입력·상태 오류 400, 중복·충돌 409, 대상 없음 404 |
| 시간 | ISO-8601 UTC |
| 회사 범위 | 회사 ID를 요청으로 받아 조회 범위를 정하지 않는다. 서버가 인증된 사용자의 회사 ID와 대상 회사 ID를 확인한다. 관리자만 전체 회사를 조회·관리한다 |
| 역할 | `MANAGER`는 자기 회사 회차 관리와 감독을 수행한다. `PROCTOR`는 자기 회사 감독 업무만 수행한다. 매니저 권한은 감독관 권한을 포함한다 |
| 캐시 | 로그인·초대 수락 응답은 `Cache-Control: no-store` |

## 기업 도입 문의

### 명단 양식 다운로드

`GET /api/company-inquiries/members-template.xlsx` — 인증 불필요, `200` 엑셀(xlsx). 회차 대상자 양식과 같은 모양이다: 제목·안내 띠, 머리 행(`회원명`·`회원이메일`·`역할`), 예시 행(지우지 않고 올려도 무시), 역할 목록(`MANAGER`/`PROCTOR`)·이메일 형식 검사, "작성 안내" 시트. (2026-11-26)

`GET /api/company-inquiries/members-template.csv` — 인증 불필요, `200 text/csv`. UTF-8 CSV 파일이며 헤더는 `회원명,회원이메일,역할`이다. 허용 역할은 `MANAGER`, `PROCTOR`다.

### 문의 제출

`POST /api/company-inquiries` — 인증 불필요, `multipart/form-data`, 성공 시 `201`

| 파트 | 필수 | 설명 |
|---|---|---|
| `companyName` | 예 | 회사명 |
| `businessNo` | 예 | 사업자등록번호. 현재 진위 확인은 하지 않는다 |
| `contactName` | 예 | 문의 담당자 이름 |
| `contactEmail` | 예 | 문의 담당자 이메일 |
| `message` | 아니오 | 문의 내용 |
| `members` | 예 | `.xlsx`(양식) 또는 `.csv` 파일. 엑셀은 첫 시트에서 `회원명`·`회원이메일`·`역할` 머리 행을 찾아 읽고, CSV 는 헤더 `회원명,회원이메일,역할`; 매니저는 정확히 1명, 감독관은 0명 이상 |

성공 응답 예:
```json
{
  "id": 31,
  "companyName": "예시 회사",
  "businessNo": "123-45-67890",
  "contactName": "홍길동",
  "contactEmail": "manager@example.com",
  "message": null,
  "status": "PENDING",
  "companyId": null,
  "createdAt": "2026-12-01T06:00:00Z",
  "members": [{"name": "홍길동", "email": "manager@example.com", "role": "MANAGER"}]
}
```

CSV 내부 중복 이메일, 허용되지 않은 역할, 매니저 수 오류, 기존 가입 이메일은 거절된다. 기존 회원 이메일은 기업 계정으로 자동 승격·이동하지 않는다.

## 관리자 API (`ADMIN`)

### 문의 목록 및 명단 교체

- `GET /api/admin/company-inquiries` — `200`, 문의와 각 명단을 반환한다.
- `POST /api/admin/company-inquiries/{inquiryId}/members` — `multipart/form-data`의 `file`(엑셀 또는 CSV)로 대기 중 문의의 명단을 통째로 교체한다. 성공 시 `200`과 갱신된 문의를 반환한다. 처리된 문의는 수정할 수 없다.

### 문의 승인·거절

- `POST /api/admin/company-inquiries/{inquiryId}/approve` — `200`, 회사 정보를 반환한다. 승인은 트랜잭션으로 회사 생성, 문의 승인, 명단 계정 저장까지만 처리하고 바로 응답한다(H2 테스트에서 1,000명 약 1초). 계정은 로그인할 수 없는 상태(`onboardingMailStatus=PENDING`)로 저장되며, 임시 비밀번호 생성과 메일 발송은 커밋 뒤 별도 스레드에서 한 명씩 처리한다. 계정별 역할은 CSV 값으로 시작한다.
- `POST /api/admin/company-inquiries/{inquiryId}/reject` — `204`.

승인 시 각 계정에는 임시 비밀번호가 발급되어 해당 이메일로 전달된다. 전달 결과는 계정의 `onboardingMailStatus`에 기록되고(`PENDING` 처리 중 → `SENT` 보냄 / `FAILED` 실패), 화면은 새로고침해야 갱신된다. 한 명이 실패해도 나머지는 계속 보낸다. 서버가 중간에 꺼져 `PENDING`으로 남거나 `FAILED`이면 관리자가 온보딩 재발급을 한다. 최초 일반 기능 이용 전 이메일 인증과 비밀번호 변경이 필요하다. 이메일 또는 비밀번호는 응답으로 반환하지 않는다.

### 회사와 매니저 관리

- `GET /api/admin/companies` — `200`, 회사 목록.
- `GET /api/admin/companies/{companyId}` — `200`, 회사 정보와 소속 회원 목록.
- `POST /api/admin/companies/{companyId}/manager` — `{"name":"새 매니저","email":"new@example.com"}`를 받아 매니저를 교체한다. 기존 매니저는 해지·탈퇴 처리되며 새 기업 계정과 임시 비밀번호가 발급된다. `200` 응답:

```json
{"companyId": 10, "managerUserId": 42, "message": "새 매니저 계정을 생성했습니다. 인증 안내 메일을 곧 발송합니다."}
```

- `POST /api/admin/members/{userId}/onboarding/reissue` — 이메일 인증 및 비밀번호 변경이 끝나지 않은 기업 계정의 임시 비밀번호를 재발급한다. 이전 세션·인증 코드는 무효화되고 기존 임시 비밀번호로 로그인할 수 없다. 새 임시 비밀번호에는 만료 시간이 없다. 회원은 로그인한 뒤 인증 코드 발송 API로 새 코드를 요청해야 한다. `200` 응답은 회원 정보와 `emailVerified`, `passwordChangeRequired`, `onboardingMailStatus`를 포함하며 비밀번호는 포함하지 않는다.

## 매니저 API (`MANAGER`)

- `GET /api/console/company/members` — `200`, 인증된 매니저와 같은 회사 회원 목록.
- `POST /api/console/company/proctor-invites` — `{"email":"proctor@example.com"}`로 같은 회사의 감독관 초대 이메일을 발송한다. `202`.
- `POST /api/console/company/manager-delegation` — `{"proctorUserId": 52}`로 같은 회사의 이메일 인증·비밀번호 변경을 마친 활성 감독관에게 매니저를 위임한다. 기존 매니저는 `PROCTOR`로 전환되고, 선택한 감독관은 `MANAGER`가 된다. 두 계정의 기존 세션은 폐기된다. `204`.

초대할 이메일이 기존 회원이면 거절한다. 활성 초대 링크는 7일간 유효하며, 이메일당 미사용 초대는 하나만 허용한다.

## 감독관 초대 가입

초대 링크에 포함된 원문 토큰은 응답 캐시에 저장하지 않는다. 초대는 `GET`으로 확인한 뒤 이메일 인증 코드와 가입 정보를 제출해 수락한다.

1. `GET /api/company-invites/{token}` — 인증 불필요, `200`.
   ```json
   {"email":"proctor@example.com","role":"PROCTOR","companyName":"예시 회사","expiresAt":"2026-12-08T06:00:00Z"}
   ```
2. `POST /api/company-invites/{token}/email-verifications` — 인증 불필요, 이메일 인증 코드를 발송한다. `202`. 이 가입 인증 코드는 일반 회원가입과 동일하게 10분 유효하다.
3. `POST /api/company-invites/accept` — 인증 불필요, `201`.
   ```json
   {"token":"초대토큰","name":"김감독","password":"새비밀번호123","code":"123456"}
   ```
   가입 이메일·역할·회사 ID는 초대 기록에서 결정한다. 응답은 로그인 토큰과 회원 정보를 포함하는 인증 응답이다.

## 기업 계정 최초 로그인 및 온보딩

CSV로 발급된 기업 계정은 `POST /api/auth/login`에 임시 비밀번호를 제출해 로그인할 수 있다. 임시 비밀번호에는 만료 시간이 없지만, 변경 전까지 로그인할 때마다 비밀번호 변경 필요 상태가 유지된다. 인증 응답의 `user.emailVerified` 및 `user.passwordChangeRequired`로 온보딩 상태를 확인한다. 온보딩이 끝나기 전에는 로그인 및 아래 인증·비밀번호 변경 API 외의 일반 API 접근이 401로 제한된다. 프론트엔드는 이 상태에서 일반 페이지 접근을 막고 인증·비밀번호 변경 화면으로 안내해야 한다.

1. `POST /api/auth/onboarding/email-verifications` — 로그인 필요. 로그인 이메일로 인증 코드를 발송한다. `202 {"message":"인증 코드를 이메일로 보냈습니다."}`. 이 코드는 만료 시각 없이 발급되며, 재발급하면 이전 코드는 무효화된다.
2. `POST /api/auth/onboarding/email-verification` — 로그인 필요. `{"code":"123456"}`를 제출한다. 성공 시 `204`.
3. `PATCH /api/auth/password` — 로그인 필요. `{"currentPassword":"임시비밀번호","newPassword":"새비밀번호123"}`를 제출한다. 새 비밀번호는 8~72자이며 현재 비밀번호와 같으면 `400`(메일로 받은 임시 비밀번호를 그대로 쓸 수 없다). 성공 시 `204`. 임시 비밀번호를 변경하기 전까지 로그인할 때마다 비밀번호 변경 상태가 유지된다.

온보딩 이메일 코드 발급은 60초 간격이며, 인증 시도는 코드당 최대 5회다. 틀린 코드의 실패 횟수는 요청이 `400`으로 끝나도 남는다. 코드 확인 뒤 가입이 실패하면 코드 소비도 함께 취소되어 같은 코드로 다시 시도할 수 있다. 메일 발송이 실패하면 방금 저장한 코드를 지우므로 60초를 기다리지 않고 바로 다시 요청할 수 있다(감독관 초대 가입 코드, 일반 가입 코드도 같다). 코드는 만료되지 않지만 새 코드를 발급하거나 인증 완료 시 기존 코드는 더 이상 사용할 수 없다.

`GET /api/auth/me` 응답의 회원 객체는 `id`, `email`, `name`, `role`, `companyId`, `emailVerified`, `passwordChangeRequired`를 포함한다. `emailVerified=false`이면 이메일 인증 화면, `passwordChangeRequired=true`이면 비밀번호 변경 안내를 표시한다.
