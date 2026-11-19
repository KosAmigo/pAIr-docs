# pAIr-docs
pAIr(AI 활용 역량 진단 플랫폼) 기획·설계 산출물 모음. 코드는 [pAIr-front](https://github.com/KosAmigo/pAIr-front), [pAIr-back](https://github.com/KosAmigo/pAIr-back).

## 목록
| 폴더 | 파일 | 내용 |
|---|---|---|
| `기획/` | 프로젝트 수행계획서(pAir)-중간 수정.docx | 팀·기간·작업명세·기반구축·일정 |
| `기획/` | 기획_결정사항.md | 애매했던 기획 요소의 확정안 (구현·ERD 기준). 원본은 pAIr-back `docs/기획_결정사항.md` |
| `설계/` | ERD(영문).png, ERD(한글).png | 데이터 모델 (테이블 39개). 원본 SQL은 pAIr-back `docs/erd/pair_schema.sql` |
| `설계/` | system-architecture.png | 시스템 아키텍처 (모듈·데이터·외부 연동) |
| `설계/` | 시스템구성도.png | 시스템 구성도 (기술 스택·주요 흐름) |
| - | [검증_결과.md](검증_결과.md) | 산출물과 실제 코드의 대조 결과, 아직 구현되지 않은 것 |

## 관리 규칙
- 기획_결정사항.md 와 ERD 는 pAIr-back `docs/` 가 원본이다. 그쪽이 바뀌면 여기 사본도 같이 바꾼다.
- 산출물은 "목표 설계"다. 지금 코드가 어디까지 왔는지는 [검증_결과.md](검증_결과.md)를 본다.
