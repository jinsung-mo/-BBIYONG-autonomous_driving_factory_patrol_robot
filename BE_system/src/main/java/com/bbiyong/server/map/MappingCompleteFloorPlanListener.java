package com.bbiyong.server.map;

import com.bbiyong.server.map.dto.MapResponses;
import com.bbiyong.server.map.service.FloorPlanService;
import com.bbiyong.server.wss.event.RobotMappingCompleteEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.event.EventListener;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 매핑 완료(EVENT_MAPPING_COMPLETE) 수신 시 2D 도면을 생성하고 관제에 완료를 알린다. (S15P11E101-518)
 * (원문 relay 는 RobotEventListener 가 별도로 수행하고, 여기서는 도면 생성·FLOORPLAN_READY 알림을 담당)
 */
@Slf4j
@Component
public class MappingCompleteFloorPlanListener {

    private final FloorPlanService floorPlanService;
    private final SimpMessagingTemplate messagingTemplate;
    private final ObjectMapper objectMapper;

    public MappingCompleteFloorPlanListener(FloorPlanService floorPlanService,
                                            SimpMessagingTemplate messagingTemplate,
                                            ObjectMapper objectMapper) {
        this.floorPlanService = floorPlanService;
        this.messagingTemplate = messagingTemplate;
        this.objectMapper = objectMapper;
    }

    @EventListener
    public void onMappingComplete(RobotMappingCompleteEvent event) {
        String robotId = event.getRobotId();
        Optional<MapResponses.Detail> plan = floorPlanService.generateFloorPlan(robotId);
        if (plan.isEmpty()) {
            return;
        }
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("type", "FLOORPLAN_READY");
            payload.put("robotId", robotId);
            payload.put("mapId", plan.get().id());
            payload.put("imageUrl", plan.get().imageUrl());
            messagingTemplate.convertAndSend("/topic/mapping", objectMapper.writeValueAsString(payload));
            log.info("Broadcast FLOORPLAN_READY for robot [{}] map [{}]", robotId, plan.get().id());
        } catch (Exception e) {
            log.error("Failed to broadcast FLOORPLAN_READY for robot [{}]", robotId, e);
        }
    }
}
