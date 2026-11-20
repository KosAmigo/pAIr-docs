# 응시 자료 PDF API

> 작성: 정현 · 2026-11-20 · 백엔드: pAIr-back `feat/create-task` (`TaskMaterialService`, `MaterialController`)
> 대상: 팀원 3 (응시 화면 PDF 뷰어, 파일 트리, AI 채팅 첨부)

AI가 만든 비개발 과제는 자료를 **PDF**로 둡니다. PDF는 응시 시작 때 응시 파일(`attempt_files`)로 복사되지 않으므로, 응시 화면은 아래 API로 목록과 파일을 따로 받아야 합니다. 텍스트 자료(CSV, md)는 지금처럼 응시 파일에 있으니 이 API에는 나오지 않습니다.

## 권한

- `/api/attempts/{id}/materials/**`는 기존 `AttemptOwnerInterceptor`가 검사합니다. 자가진단은 응시 주인만 쓸 수 있고, 남의 응시는 403, 로그인하지 않았으면 401입니다. 실전 응시는 기존 응시 API와 같은 방식으로 들어옵니다.
- 응시 상태와 상관없이 읽을 수 있습니다. 제출 후 복기와 리포트에서도 볼 수 있습니다.
- 숨은 파일(HIDDEN)과 다른 과제 파일은 어떤 경로로도 나오지 않습니다(404).

## 1. 자료 PDF 목록

`GET /api/attempts/{id}/materials`

```json
[
  { "path": "자료/경쟁사 비교.pdf", "mimeType": "application/pdf", "sizeBytes": 18234, "pages": 3 },
  { "path": "자료/요금 안내.pdf",   "mimeType": "application/pdf", "sizeBytes": 25110, "pages": 4 }
]
```

- 공개 PDF만 경로 순서로 옵니다. 없으면 `[]`입니다.
- 파일 트리의 `자료/` 아래에 이 목록을 함께 보여 주면 됩니다.

## 2. PDF 파일

`GET /api/attempts/{id}/materials/file?path=자료/요금 안내.pdf`

- 응답은 PDF 바이트입니다. 헤더:
  - `Content-Type: application/pdf`
  - `Content-Disposition: inline; filename*=UTF-8''…`
  - `Cache-Control: private, max-age=300`
  - `X-Content-Type-Options: nosniff`
- 목록에 없는 경로는 404입니다.
- 뷰어 예: 응답을 `blob`으로 받아 `URL.createObjectURL`로 `<iframe>`이나 pdf.js에 넘깁니다. 인증 헤더가 필요하니 `<iframe src>`에 URL을 바로 넣지 말고 fetch로 받으세요.

## 3. 쪽 글 (AI 채팅 첨부용)

`GET /api/attempts/{id}/materials/pages?path=자료/요금 안내.pdf&pages=1,3-4`

```json
[
  { "page": 1, "text": "1쪽 글" },
  { "page": 3, "text": "3쪽 글" },
  { "page": 4, "text": "4쪽 글" }
]
```

- `pages`는 `1`, `1,3`, `2-4`처럼 씁니다. 중복은 없애고 쪽 순서로 돌려줍니다.
- 한 번에 최대 **20쪽**입니다. 넘으면 400입니다. `pages`를 빼면 전체를 주지만, 문서가 20쪽을 넘으면 400입니다.
- 형식이 틀리거나 없는 쪽을 달라고 하면 400입니다.
- **AI 채팅에 PDF를 첨부할 때는 바이트가 아니라 이 글을 넘깁니다.** 응시자가 고른 쪽만 첨부하게 하면 토큰도 아끼고, "어떤 자료를 골라 넘기는지"도 평가에 남습니다.

## 관리자 검수용 (참고)

`GET /api/console/tasks/{code}/materials`, `…/materials/file?path=`, `…/materials/pages?path=&pages=`

- 위와 같은 모양이고 ADMIN만 쓸 수 있습니다. 검수 전(HIDDEN) 과제도 보입니다.
