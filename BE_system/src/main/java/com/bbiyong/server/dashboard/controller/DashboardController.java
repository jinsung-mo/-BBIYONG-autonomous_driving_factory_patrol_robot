package com.bbiyong.server.dashboard.controller;

import com.bbiyong.server.dashboard.dto.DashboardStatsResponse;
import com.bbiyong.server.dashboard.service.DashboardService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 관제센터 대시보드 API
 */
@Tag(name = "Dashboard", description = "관제센터 대시보드 통계 API")
@RestController
@RequestMapping("/api/dashboard")
public class DashboardController {

    private final DashboardService dashboardService;

    public DashboardController(DashboardService dashboardService) {
        this.dashboardService = dashboardService;
    }

    @Operation(
            summary = "대시보드 통합 통계 조회",
            description = """
                    관제센터 메인 화면에 표시할 통합 통계를 한 번의 요청으로 조회합니다.

                    **응답 데이터**:
                    - summary: 로봇 상태 요약 (전체/활성/충전중/평균배터리)
                    - today: 오늘 이벤트 통계 (총 건수, 치명적/경고/해결/미해결)
                    - recentEvents: 최근 이벤트 5건
                    - robotStatus: 전체 로봇 현재 상태

                    **활용**:
                    - 페이지 로드 시 1회 호출
                    - 실시간 갱신은 WebSocket STOMP 구독 권장
                    - 캐싱 가능 (5초 TTL)

                    **성능**:
                    - 평균 응답 시간: ~50ms
                    - 로봇 10대, 이벤트 1000건 기준
                    """,
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @ApiResponses({
            @ApiResponse(
                    responseCode = "200",
                    description = "통계 조회 성공",
                    content = @Content(
                            mediaType = "application/json",
                            schema = @Schema(implementation = DashboardStatsResponse.class)
                    )
            ),
            @ApiResponse(
                    responseCode = "401",
                    description = "인증 실패 - 유효한 JWT 토큰이 필요합니다"
            )
    })
    @GetMapping("/stats")
    public ResponseEntity<DashboardStatsResponse> getStats() {
        DashboardStatsResponse stats = dashboardService.getStats();
        return ResponseEntity.ok(stats);
    }
}
