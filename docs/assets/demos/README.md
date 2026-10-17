# 매핑·관제 짧은 시연

팀 발표 자료에서 원본 GIF를 추출해 웹에서 제어하며 재생할 수 있는 H.264 MP4로 변환했습니다. 원본 발표 파일은 수정하지 않았습니다.

| 파일 | 발표 슬라이드 | 원본 미디어 | 발췌 구간 |
| --- | ---: | --- | --- |
| mapping-progress.mp4 | 20 | ppt/media/image9.gif | 전체 약 9.83초 |
| localization.mp4 | 38 | ppt/media/image32.gif | 전체 약 10.2초 |
| priority-patrol.mp4 | 25 | ppt/media/image17.gif | 시작부터 12초 |
| fire-alert.mp4 | 28 | ppt/media/image20.gif | 전체 약 8.9초 |

원본 속도를 유지했으며 소리는 없습니다. 긴 발표 전체를 게시하는 대신 각 기능의 짧은 구간을 독립적으로 제공합니다. GIF 자체가 발표용 시연 화면이므로 물리 장치 촬영 영상이나 현재 서비스에 접속해 녹화한 영상과는 구분합니다.

같은 이름의 GIF는 각 MP4에서 만든 README용 반복 미리보기입니다. 가로 640px, 6 FPS, 최대 96색으로 줄였으며 속도는 유지했습니다. 각 파일은 4 MB 미만입니다. README에는 GIF를 표시하고 MP4를 링크해 정지 JPG만 보이던 구성을 바꿨습니다.

최대 가로 960px, 20 FPS, H.264, yuv420p, faststart로 인코딩했습니다. 포스터는 원본 GIF의 중간 프레임입니다. 파일 크기·SHA-256·원본 재생 시간은 [sources.json](sources.json)에 기록했습니다.

기존 README의 GIF는 계속 사용할 수 있습니다. 이 폴더의 소용량 MP4는 Git LFS 대신 일반 Git 객체로 저장해 링크로 바로 접근할 수 있게 했습니다.
