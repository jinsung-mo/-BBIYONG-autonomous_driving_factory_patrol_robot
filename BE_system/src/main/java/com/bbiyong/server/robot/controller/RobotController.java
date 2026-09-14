package com.bbiyong.server.robot.controller;

import com.bbiyong.server.robot.dto.RobotHealthHistoryResponse;
import com.bbiyong.server.robot.dto.RobotRecoveryResponse;
import com.bbiyong.server.robot.dto.RobotResponse;
import com.bbiyong.server.robot.service.RobotHealthHistoryService;
import com.bbiyong.server.robot.service.RobotRecoveryService;
import com.bbiyong.server.robot.service.RobotService;
import org.springframework.security.access.prepost.PreAuthorize;
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
    private final RobotRecoveryService recoveryService;

    public RobotController(RobotService robotService,
                           RobotHealthHistoryService healthHistoryService,
                           RobotRecoveryService recoveryService) {
        this.robotService = robotService;
        this.healthHistoryService = healthHistoryService;
        this.recoveryService = recoveryService;
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

    @Operation(
            summary = "Nav2 복구 (경로 계산 서버 재기동)",
            description = """
                    로봇의 Nav2 코어(planner/controller/bt_navigator …)를 내렸다 올립니다.
                    이벤트 로그의 `PLANNER_DOWN` 항목에서 관제사가 확인 후 누르는 버튼용입니다.

                    **🔴 주행이 끊깁니다.** 재기동 동안 로봇은 움직일 수 없고, 순찰 중이었다면
                    순찰이 중단됩니다(로봇이 먼저 주행을 정상 정지한 뒤 재기동합니다).
                    그래서 서버가 자동으로 호출하지 않습니다.

                    **응답은 하달까지의 결과입니다.** 재기동은 수십 초가 걸리므로 성패는
                    로봇이 되돌려 주는 이벤트 로그(PLANNER_RECOVER_OK / PLANNER_RECOVER_FAILED)로
                    확인합니다. `GET /api/events` 를 폴링하세요.

                    - `ACCEPTED` 하달됨 · `IN_PROGRESS` 이미 복구 중(180초 쿨다운)
                    - `OFFLINE` 로봇 미연결 · `INVALID` robotId 누락
                    """,
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @ApiResponses({
            @ApiResponse(responseCode = "200", description = "명령 하달 결과",
                    content = @Content(mediaType = "application/json",
                            schema = @Schema(implementation = RobotRecoveryResponse.class))),
            @ApiResponse(responseCode = "401", description = "인증 실패"),
            @ApiResponse(responseCode = "403", description = "관제(ADMIN) 권한이 아님")
    })
    // 로봇을 실제로 움직이는(정확히는 멈추는) 명령이므로 조회 API 와 달리 ADMIN 으로 막는다.
    // STOMP 의 drive/mode 명령과 같은 기준이다(RobotControlStompController.CONTROL_AUTHORITIES).
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/{robotId}/recover/nav2")
    public ResponseEntity<RobotRecoveryResponse> recoverNav2(@PathVariable String robotId) {
        return ResponseEntity.ok(recoveryService.recoverNav2(robotId));
    }
}
