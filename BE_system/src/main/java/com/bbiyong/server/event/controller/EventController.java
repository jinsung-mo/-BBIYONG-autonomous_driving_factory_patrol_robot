package com.bbiyong.server.event.controller;

import com.bbiyong.server.event.domain.EventLog;
import com.bbiyong.server.event.dto.EventPageResponse;
import com.bbiyong.server.event.dto.EventStatusUpdateRequest;
import com.bbiyong.server.event.service.EventLogService;
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

    public EventController(EventLogService eventLogService) {
        this.eventLogService = eventLogService;
    }

    @Operation(
            summary = "이벤트 이력 조회",
            description = """
                    화재 및 장비 과열 감지, 로봇 이상 이벤트 이력을 페이징 조회합니다.

                    **쿼리 파라미터**:
                    - page: 페이지 번호 (0부터 시작, 기본값 0)
                    - size: 페이지 크기 (기본값 10)
                    - type: 이벤트 타입 필터 (FIRE, OVERHEAT, SYSTEM 중 택일, 생략 시 전체)

                    **이벤트 타입**:
                    - FIRE: 화재 감지 이벤트 (로봇 교차검증 확정)
                    - OVERHEAT: 설비 과열 이벤트
                    - SYSTEM: 시스템 이상 이벤트

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
                    description = "잘못된 요청 파라미터 (예: 음수 페이지 번호)"
            )
    })
    @GetMapping
    public ResponseEntity<EventPageResponse> getEvents(
            @Parameter(description = "페이지 번호 (0부터 시작)", example = "0")
            @RequestParam(defaultValue = "0") int page,
            @Parameter(description = "페이지 크기", example = "10")
            @RequestParam(defaultValue = "10") int size,
            @Parameter(description = "이벤트 타입 필터 (FIRE, OVERHEAT, SYSTEM)", example = "FIRE")
            @RequestParam(required = false) String type) {
        return ResponseEntity.ok(eventLogService.getEvents(page, size, type));
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
}
