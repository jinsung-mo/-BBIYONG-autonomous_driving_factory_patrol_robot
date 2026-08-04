package com.bbiyong.server.robot.controller;

import com.bbiyong.server.robot.dto.RobotHealthHistoryResponse;
import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.robot.service.RobotHealthHistoryService;
import com.bbiyong.server.robot.service.RobotService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@Tag(name = "Robot", description = "로봇 조회 및 관리 API")
@RestController
@RequestMapping("/api/robots")
public class RobotController {

    private final RobotService robotService;
    private final RobotHealthHistoryService healthHistoryService;

    public RobotController(RobotService robotService, RobotHealthHistoryService healthHistoryService) {
        this.robotService = robotService;
        this.healthHistoryService = healthHistoryService;
    }

    @Operation(
            summary = "로봇 목록 조회",
            description = """
                    관리자에게 배정된 모든 로봇의 실시간 상태 요약을 조회합니다.

                    **응답 정보**:
                    - robotId: 로봇 고유 ID
                    - status: 로봇 상태 (AUTO_PATROL, APPROACH, VERIFY, MANUAL_CONTROL, MAPPING)
                    - battery: 배터리 잔량 (%)
                    - online: 연결 상태 (true/false)
                    - location: 현재 위치 (x, y, yaw)
                    - estop, commLatencyMs, inferenceFps 등 확장 필드 포함

                    **참고**: 실시간 갱신은 WebSocket STOMP `/topic/robots` 구독으로 가능합니다.
                    """,
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @ApiResponses({
            @ApiResponse(
                    responseCode = "200",
                    description = "로봇 목록 조회 성공",
                    content = @Content(
                            mediaType = "application/json",
                            schema = @Schema(implementation = RobotResponse.class)
                    )
            ),
            @ApiResponse(
                    responseCode = "401",
                    description = "인증 실패 - 유효한 JWT 토큰이 필요합니다"
            )
    })
    @GetMapping
    public ResponseEntity<List<RobotResponse>> getRobots() {
        return ResponseEntity.ok(robotService.getAllRobots());
    }

    @Operation(
            summary = "로봇 건강 이력 조회",
            description = """
                    특정 로봇의 건강 상태 이력(배터리, 통신 지연, FPS 등)을 조회합니다.

                    **기간 형식**:
                    - 1h, 6h, 24h: 시간 단위
                    - 7d, 30d: 일 단위
                    - 기본값: 24h

                    **차트 렌더링용 데이터**: 시간 순으로 정렬된 데이터 포인트 배열
                    """,
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @GetMapping("/{robotId}/health-history")
    public ResponseEntity<RobotHealthHistoryResponse> getHealthHistory(
            @PathVariable String robotId,
            @RequestParam(defaultValue = "24h") String period) {
        return ResponseEntity.ok(healthHistoryService.getHealthHistory(robotId, period));
    }
}
