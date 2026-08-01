package com.bbiyong.server.event.controller;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.dto.EventStatsResponse;
import com.bbiyong.server.event.dto.EventStatusUpdateRequest;
import com.bbiyong.server.event.service.EventLogService;
import com.bbiyong.server.event.service.EventStatsService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.responses.ApiResponses;
import io.swagger.v3.oas.annotations.security.SecurityRequirement;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@Tag(name = "Event", description = "이벤트 로그 및 경보 관리 API")
@RestController
@RequestMapping("/api/events")
public class EventController {

    private final EventLogService eventLogService;
    private final EventStatsService eventStatsService;

    public EventController(EventLogService eventLogService, EventStatsService eventStatsService) {
        this.eventLogService = eventLogService;
        this.eventStatsService = eventStatsService;
    }

    @Operation(
            summary = "이벤트 이력 조회 (고급 필터링)",
            description = """
                    화재 및 장비 과열 감지, 로봇 이상 이벤트 이력을 다양한 조건으로 필터링하여 조회합니다.

                    **필터 파라미터**:
                    - page: 페이지 번호 (0부터 시작, 기본값 0)
                    - size: 페이지 크기 (기본값 10)
                    - type: 이벤트 타입 (FIRE, OVERHEAT, SYSTEM)
                    - level: 심각도 (CRITICAL, WARNING)
                    - status: 해결 상태 (UNRESOLVED, RESOLVED)
                    - robotId: 특정 로봇 ID
                    - equipmentId: 특정 설비 ID (OVERHEAT 전용)
                    - startDate: 시작 날짜 (YYYY-MM-DD)
                    - endDate: 종료 날짜 (YYYY-MM-DD)

                    **사용 예시**:
                    - 미해결 화재 이벤트: `?type=FIRE&status=UNRESOLVED`
                    - 최근 1주일 E101 로봇 이벤트: `?robotId=E101&startDate=2026-07-25`
                    - 분전반 C 과열 이력: `?equipmentId=분전반_C&type=OVERHEAT`

                    **실시간 경보**: WebSocket STOMP `/topic/alerts` 구독으로 신규 경보 실시간 수신 가능
                    """,
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @ApiResponses({
            @ApiResponse(
                    responseCode = "200",
                    description = "이벤트 이력 조회 성공",
                    content = @Content(
                            mediaType = "application/json",
                            schema = @Schema(implementation = EventPageResponse.class)
                    )
            ),
            @ApiResponse(
                    responseCode = "401",
                    description = "인증 실패 - 유효한 JWT 토큰이 필요합니다"
            ),
            @ApiResponse(
                    responseCode = "400",
                    description = "잘못된 요청 파라미터"
            )
    })
    @GetMapping
    public ResponseEntity<EventPageResponse> getEvents(
            @Parameter(description = "페이지 번호 (0부터 시작)", example = "0")
            @RequestParam(defaultValue = "0") int page,
            @Parameter(description = "페이지 크기", example = "10")
            @RequestParam(defaultValue = "10") int size,
            @Parameter(description = "이벤트 타입 (FIRE, OVERHEAT, SYSTEM)", example = "FIRE")
            @RequestParam(required = false) String type,
            @Parameter(description = "심각도 (CRITICAL, WARNING)", example = "CRITICAL")
            @RequestParam(required = false) String level,
            @Parameter(description = "해결 상태 (UNRESOLVED, RESOLVED)", example = "UNRESOLVED")
            @RequestParam(required = false) String status,
            @Parameter(description = "로봇 ID", example = "E101")
            @RequestParam(required = false) String robotId,
            @Parameter(description = "설비 ID", example = "분전반_C")
            @RequestParam(required = false) String equipmentId,
            @Parameter(description = "시작 날짜 (YYYY-MM-DD)", example = "2026-08-01")
            @RequestParam(required = false) String startDate,
            @Parameter(description = "종료 날짜 (YYYY-MM-DD)", example = "2026-08-07")
            @RequestParam(required = false) String endDate) {
        return ResponseEntity.ok(eventLogService.getEventsWithFilters(
                page, size, type, level, status, robotId, equipmentId, startDate, endDate));
    }

    @Operation(
            summary = "경보 상태 업데이트",
            description = """
                    경보(이벤트) 상태를 전이합니다. 관제사가 확인 후 처리완료(RESOLVED) 등으로 표시할 수 있습니다.

                    **상태 값**:
                    - UNRESOLVED: 미해결 (신규 경보 기본값)
                    - RESOLVED: 해결 완료 (관제사 처리 완료)
                    - ACKNOWLEDGED: 확인됨 (조치 진행 중)
                    """,
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @ApiResponses({
            @ApiResponse(
                    responseCode = "200",
                    description = "경보 상태 업데이트 성공",
                    content = @Content(
                            mediaType = "application/json",
                            schema = @Schema(implementation = EventLog.class)
                    )
            ),
            @ApiResponse(
                    responseCode = "401",
                    description = "인증 실패"
            ),
            @ApiResponse(
                    responseCode = "404",
                    description = "해당 ID의 이벤트를 찾을 수 없음"
            ),
            @ApiResponse(
                    responseCode = "400",
                    description = "잘못된 상태 값"
            )
    })
    @PatchMapping("/{eventId}")
    public ResponseEntity<EventLog> updateStatus(
            @Parameter(description = "이벤트 ID", example = "1")
            @PathVariable Long eventId,
            @Valid @RequestBody EventStatusUpdateRequest request) {
        return ResponseEntity.ok(eventLogService.updateStatus(eventId, request.status()));
    }

    @Operation(
            summary = "시간별 이벤트 통계",
            description = "지정된 시간 동안의 시간별 이벤트 발생 통계를 조회합니다. (차트용)",
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @GetMapping("/stats/hourly")
    public ResponseEntity<EventStatsResponse> getHourlyStats(
            @Parameter(description = "조회할 시간 범위 (시간)", example = "24")
            @RequestParam(defaultValue = "24") int hours) {
        return ResponseEntity.ok(eventStatsService.getHourlyStats(hours));
    }

    @Operation(
            summary = "일별 이벤트 통계",
            description = "지정된 기간 동안의 일별 이벤트 발생 통계를 조회합니다. (차트용)",
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @GetMapping("/stats/daily")
    public ResponseEntity<EventStatsResponse> getDailyStats(
            @Parameter(description = "조회할 일수", example = "7")
            @RequestParam(defaultValue = "7") int days) {
        return ResponseEntity.ok(eventStatsService.getDailyStats(days));
    }

    @Operation(
            summary = "로봇별 이벤트 통계",
            description = "지정된 기간 동안 로봇별 이벤트 발생 통계를 조회합니다. (차트용)",
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @GetMapping("/stats/by-robot")
    public ResponseEntity<EventStatsResponse> getStatsByRobot(
            @Parameter(description = "조회할 일수", example = "7")
            @RequestParam(defaultValue = "7") int days) {
        return ResponseEntity.ok(eventStatsService.getStatsByRobot(days));
    }

    @Operation(
            summary = "설비별 이벤트 통계",
            description = "지정된 기간 동안 설비별 과열 이벤트 통계를 조회합니다. (차트용)",
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @GetMapping("/stats/by-equipment")
    public ResponseEntity<EventStatsResponse> getStatsByEquipment(
            @Parameter(description = "조회할 일수", example = "7")
            @RequestParam(defaultValue = "7") int days) {
        return ResponseEntity.ok(eventStatsService.getStatsByEquipment(days));
    }

    @Operation(
            summary = "이벤트 타입별 통계",
            description = "지정된 기간 동안 이벤트 타입별 통계를 조회합니다. (차트용)",
            security = @SecurityRequirement(name = "bearerAuth")
    )
    @GetMapping("/stats/by-type")
    public ResponseEntity<EventStatsResponse> getStatsByType(
            @Parameter(description = "조회할 일수", example = "7")
            @RequestParam(defaultValue = "7") int days) {
        return ResponseEntity.ok(eventStatsService.getStatsByType(days));
    }
}
