# 0006. Java 17과 Spring Boot 4.1

- 날짜: 2026-07-20 (프로젝트 생성)
- 상태: 채택

> 당시 버전을 비교한 문서는 남아 있지 않습니다. 아래는 코드와 설정, 이후 겪은 문제를 바탕으로 정리한 판단 근거입니다.

## 배경

6명이 로컬, CI(Jenkins), 운영(Docker) 세 환경에서 같은 서버를 빌드해야 했습니다. 개발 기간은 4주였습니다.

## 판단 기준: 최신은 하나만

**Spring Boot 4.1**
- 착수 시점(2026-07)에 Boot 4는 현행 세대였습니다. 3.x로 시작하면 개발이 끝나자마자 메이저 버전 이전(Spring Framework 7, Jakarta EE 11, Jackson 3)을 떠안게 됩니다.
- 이 시스템은 로봇, 서버, 웹이 모두 JSON으로 대화합니다. Boot 4의 기본 JSON 스택인 Jackson 3을 처음부터 쓰면 나중에 다시 옮길 필요가 없습니다.
- 기능별로 나뉜 스타터(`webmvc`, `websocket`, `restclient`, `*-test`)로 필요한 것만 들였습니다.

**Java 17**
- Boot 3부터 이어진 최소 요구 버전입니다. 프레임워크를 최신으로 고른 만큼 JDK는 최소 요구 LTS로 두어, OpenCV 네이티브(bytedeco), DB 드라이버 같은 서드파티 호환 위험을 줄였습니다.
- 동시 연결은 로봇 1대와 관제 화면 몇 개 수준이었습니다. 실제로 풀어야 했던 문제는 스레드 수가 아니라 순서 보장([0003](0003-async-single-thread-alert-persistence.md))이라, Java 21의 가상 스레드가 결정적인 이점은 아니었습니다.

## 결정

Java 17(Temurin), Spring Boot 4.1.0. Gradle toolchain(foojay)으로 JDK 17을 자동으로 받게 해서, JDK가 없는 PC에서도 같은 버전으로 빌드되게 했습니다.

## 결과

- 얻은 것: 로컬, CI, 운영이 같은 JDK. 메이저 이전 부채 없음.
- 치른 대가: 최신 프레임워크라 서드파티 호환 문제가 실제로 났습니다. SpringDoc 2.6.0이 `NoSuchMethodError`를 내서 2.7.0으로 올렸고, Tomcat 설정 클래스의 패키지 이동에 맞춰 WebSocket 버퍼 설정을 다시 썼습니다. 둘 다 CI 테스트가 배포 전에 잡았습니다.
- 앞으로: Java 17은 벤더 지원 기간이 줄어들고 있어 운영이 길어지면 21 또는 25 LTS로 올려야 합니다. toolchain 선언과 베이스 이미지 태그만 바꾸면 됩니다.

## 근거

- [`build.gradle`](../../BE_system/build.gradle), [`Dockerfile`](../../BE_system/Dockerfile)
