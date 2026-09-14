# README 시각 자료

팀 제공 발표 자료 `15기 공통PJT_부울경_E101_삐용.pptx`의 `ppt/media/`에서 이미지를 추출하고, 실제 로봇 촬영 MOV에서 짧은 주행 구간을 발췌했습니다. 다운로드 폴더의 원본 발표 자료와 영상은 수정하지 않았습니다.

| 파일 | 슬라이드 | 내용 |
| --- | --- | --- |
| `robot-concept.png` | 1 | 로봇 디자인 콘셉트. 실물 사진이 아님 |
| `mapping-console.png` | 17 | 지도 관리 화면 |
| `map-3d.png` | 21 | 지도 3D 화면 |
| `frontier-exploration.gif` | 24 | 지도 기반 탐색 시연 |
| `event-log.png` | 31 | 이벤트 목록 |
| `event-detail.png` | 31 | 이벤트 상세 |
| `fire-detection.gif` | 50 | 화재 탐지 시연 |
| `thermal-verification.gif` | 58 | 불꽃·열화상 확인 실험 |
| `patrol-console.png` | 23 | 순찰 설정 관제 화면 |
| `patrol-route-plan.png` | 23 | 순찰 경로 구성 |
| `patrol-route-map.png` | 23 | 지도 위 순찰 경로 |
| `event-log-overview.png` | 29·30 | 이벤트 목록 개요 |
| `mapping-progress.gif` | 20 | 지도 생성 과정 |
| `priority-patrol.gif` | 25 | 우선 구역 반복 순찰 |
| `fire-alert-console.gif` | 28 | 관제 화면의 화재 경보 |
| `navigation-recovery.gif` | 47 | 3D 지도에서의 주행 복구 시연 |

반복 등장하는 동일 화면과 장식용 노트북 프레임은 중복 추가하지 않았습니다. 관제 화면과 시연 데이터는 발표 당시 자료이며 현재 실행 화면과 차이가 있을 수 있습니다.

## 실제 주행 영상

원본: `시연영상_202608013_1700.mov` (20분 19.77초, 약 2.67 GB).

- 사용 구간: **01:00~01:20**, 20초, 원본 재생 속도 유지.
- `autonomous-driving.mp4`: H.264, 가로 960px, 24 FPS, 무음, 약 0.49 MiB. 웹 재생을 위한 faststart 적용.
- `autonomous-driving.gif`: 가로 640px, 8 FPS, 약 4.30 MiB. README에서 바로 볼 수 있는 반복 미리보기.
- 화면 내용: 박스로 장애물을 배치한 실내에서 실제 로봇이 이동하는 촬영 장면.

전체 발표 녹화 `최종녹화.mp4`도 시간대별로 검토했으며, 실제 주행 구간은 로봇을 직접 촬영한 MOV에서 선택했습니다.

## 용량과 가공

정지 이미지는 원본 파일을 사용합니다. 지도 생성·반복 순찰·화재 경보·복구·열화상 GIF는 해상도, 프레임 수, 색상 수를 줄여 재인코딩했으며 재생 속도는 유지했습니다. 전체 자료 18개는 약 **30.92 MiB**입니다. 원본 용량이 큰 전체 MOV/MP4 영상은 저장소에 추가하지 않았습니다.

원본 미디어 경로, 슬라이드 번호, 구간·인코딩 설정, 파일 크기 및 SHA-256은 [sources.json](sources.json)에 기록했습니다.

README의 소개·스크린샷·기술 스택·실행 안내 구성은 [Best-README-Template](https://github.com/othneildrew/Best-README-Template)을 참고했으며, 본문은 프로젝트 코드와 팀 발표 자료를 바탕으로 작성했습니다.
