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
        Double x,
        Double y,
        String message,
        String timestamp
) {
    public static AlertMessage fromFire(RobotPacket p) {
        Double x = null, y = null;
        if (p.getLocation() != null) { x = p.getLocation().getX(); y = p.getLocation().getY(); }
        return new AlertMessage(
                "FIRE", "CRITICAL", "ROBOT", p.getRobotId(),
                p.getConfidence(), p.getTemperature(), null, x, y,
                "순찰 로봇(" + p.getRobotId() + ")이 근접 교차검증으로 화재를 확정했습니다.",
                Instant.now().toString());
    }

    public static AlertMessage fromOverheat(RobotPacket p) {
        Double x = null, y = null;
        if (p.getLocation() != null) { x = p.getLocation().getX(); y = p.getLocation().getY(); }
        return new AlertMessage(
                "OVERHEAT", "WARNING", "ROBOT", p.getRobotId(),
                null, p.getTemperature(), p.getEquipmentId(), x, y,
                "설비(" + p.getEquipmentId() + ") 과열이 감지되었습니다.",
                Instant.now().toString());
    }
}
