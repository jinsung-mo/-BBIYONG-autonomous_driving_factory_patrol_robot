package com.bbiyong.server.robot.dto;

/**
 * 로봇 복구 명령 하달 결과.
 *
 * <p>{@code result} 는 <b>하달까지의</b> 결과일 뿐 복구의 성패가 아니다. 실제 성패는 로봇이
 * 되돌려 주는 조용한 시스템 로그(PLANNER_RECOVER_OK / PLANNER_RECOVER_FAILED)로 확인한다 —
 * Nav2 재기동은 수십 초가 걸려 HTTP 응답 안에서 기다릴 수 없다.
 *
 * @param result    ACCEPTED | IN_PROGRESS | OFFLINE | INVALID
 * @param delivered 로봇 WSS 세션으로 실제 하달됐는가
 * @param message   관제가 그대로 보여 줄 문장
 */
public record RobotRecoveryResponse(String result, boolean delivered, String message) {
}
