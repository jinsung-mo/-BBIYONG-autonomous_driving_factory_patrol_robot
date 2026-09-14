package com.bbiyong.server.stats.controller;

import com.bbiyong.server.stats.dto.StatsResponses;
import com.bbiyong.server.stats.service.StatsService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 통계 대시보드 집계 API. (S15P11E101-767)
 */
@Tag(name = "Stats", description = "통계 대시보드 집계 API")
@RestController
@RequestMapping("/api/stats")
public class StatsController {

    private static final String DEFAULT_ROBOT_ID = "orinka_01";

    private final StatsService statsService;

    public StatsController(StatsService statsService) {
        this.statsService = statsService;
    }

    @Operation(summary = "설비별 과열 이벤트 랭킹",
            description = "기간 내 설비(분전반)별 과열 이벤트 수를 최다 순으로 반환합니다. 예방 점검 대상 식별용. "
                    + "시연용(simulated) 이벤트는 기본 제외합니다.",
            security = @SecurityRequirement(name = "bearerAuth"))
    @GetMapping("/overheat-equipment")
    public ResponseEntity<StatsResponses.OverheatEquipment> overheatEquipment(
            @RequestParam(defaultValue = "7") int days,
            @RequestParam(defaultValue = "false") boolean includeSimulated) {
        return ResponseEntity.ok(statsService.overheatByEquipment(days, includeSimulated));
    }

    @Operation(summary = "일별 경보 추이",
            description = "최근 N일(기본 7일)의 일별 화재/과열/합계 건수를 반환합니다. 이벤트가 없는 날은 0으로 채웁니다(Asia/Seoul 기준).",
            security = @SecurityRequirement(name = "bearerAuth"))
    @GetMapping("/alerts-weekly")
    public ResponseEntity<StatsResponses.AlertsWeekly> alertsWeekly(
            @RequestParam(defaultValue = "7") int days,
            @RequestParam(defaultValue = "false") boolean includeSimulated) {
        return ResponseEntity.ok(statsService.alertsWeekly(days, includeSimulated));
    }

    @Operation(summary = "배터리 방전 추세·예상 잔여 가동시간",
            description = "최근 건강 이력의 선형회귀로 방전율(%/h)과 예상 잔여 가동시간(분)을 추정합니다. "
                    + "충전 중이거나 표본이 부족하면 추정값은 null 입니다.",
            security = @SecurityRequirement(name = "bearerAuth"))
    @GetMapping("/battery-estimate")
    public ResponseEntity<StatsResponses.BatteryEstimate> batteryEstimate(
            @RequestParam(required = false) String robotId,
            @RequestParam(defaultValue = "60") int limit) {
        String id = (robotId != null && !robotId.isBlank()) ? robotId : DEFAULT_ROBOT_ID;
        return ResponseEntity.ok(statsService.batteryEstimate(id, limit));
    }
}
