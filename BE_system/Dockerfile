FROM eclipse-temurin:17-jdk AS build

WORKDIR /workspace

COPY gradlew gradlew
COPY gradle gradle
COPY build.gradle settings.gradle ./

RUN chmod +x gradlew
RUN ./gradlew dependencies --no-daemon

COPY src src
RUN mkdir -p data
RUN ./gradlew bootJar --no-daemon

FROM eclipse-temurin:17-jre

WORKDIR /app

# ffmpeg — 사건 클립을 HLS 세그먼트(.ts)에서 잘라 mp4 로 remux 하는 데 쓴다
# (EventClipService). 재인코딩이 아니라 `-c copy` 스트림 복사라 CPU 를 거의 쓰지 않는다.
#
# 왜 컨테이너 안에 넣나 — 자를 재료(.ts)와 자를 도구가 같은 곳에 있어야 절단이 평범한
# Spring 리스너 하나로 끝난다. 호스트에 도구를 두면 컨테이너 밖 프로세스와 그것에게
# 일을 시키는 두 번째 계약(요청 파일·인증)이 생긴다.
# 대가: 이미지가 커진다(약 80MB). --no-install-recommends 로 최소만 넣는다.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home spring

COPY --from=build /workspace/build/libs/*.jar app.jar
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data && chown -R spring:spring /app
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
