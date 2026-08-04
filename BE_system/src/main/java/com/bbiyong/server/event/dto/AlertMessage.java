package com.bbiyong.server.event.dto;

import com.bbiyong.server.wss.dto.RobotPacket;

import java.time.Instant;

/**
 * 관제 대시보드 실시간 경보(/topic/alerts) 표준 페이로드.
 * 로봇이 확정한 화재(FIRE)/과열(OVERHEAT) 이벤트를 통일된 형태로 브로드캐스트한다.
 */
public record AlertMessage(
        String type,          // FIRE | OVERHEAT
        String level,         // CRITICAL | WARNING
        String source,        // ROBOT
        String robotId,
        Double confidence,    // FIRE 전용
        Double temperature,
        String equipmentId,   // OVERHEAT 전용
        Double threshold,     // OVERHEAT 전용 (로봇 판정 임계치)
        String thermalImage,  // OVERHEAT 전용 열화상 base64 (중계만, 미저장)
        Double x,
        Double y,
        String message,
        String timestamp
) {
    public static AlertMessage fromFire(RobotPacket p) {
        return new AlertMessage(
                "FIRE", "CRITICAL", sourceOf(p), p.getRobotId(),
                p.getConfidence(), p.getTemperature(), null, null, null, 0.0, 0.0,
                prefix(p) + "화재 발생",
                timestampOf(p).toString());
    }

    public static AlertMessage fromOverheat(RobotPacket p) {
        return new AlertMessage(
                "OVERHEAT", "WARNING", sourceOf(p), p.getRobotId(),
                null, p.getTemperature(), p.getEquipmentId(), p.getThreshold(), p.getThermalImage(), 0.0, 0.0,
                prefix(p) + "과열 발생",
                timestampOf(p).toString());
    }

    private static String sourceOf(RobotPacket p) {
        return "SIMULATION".equalsIgnoreCase(p.getSource()) ? "SIMULATION" : "ROBOT";
    }

    private static String prefix(RobotPacket p) {
        return "SIMULATION".equalsIgnoreCase(p.getSource()) ? "[테스트] " : "";
    }

    private static Instant timestampOf(RobotPacket p) {
        return p.getTimestamp() == null ? Instant.now() : Instant.ofEpochSecond(p.getTimestamp());
    }
}
