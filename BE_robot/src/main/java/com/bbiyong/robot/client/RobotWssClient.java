package com.bbiyong.robot.client;

import com.bbiyong.robot.dto.LocationDto;
import com.bbiyong.robot.dto.RobotFireEventPacket;
import com.bbiyong.robot.dto.RobotTelemetryPacket;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;

@Slf4j
public class RobotWssClient implements WebSocket.Listener {

    private final String serverUri;
    private final String robotId;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;

    private WebSocket webSocket;
    private volatile boolean running = true;
    private double currentX = 12.34;
    private double currentY = 5.67;
    private double currentYaw = 1.57;

    public RobotWssClient(String serverUri, String robotId) {
        this.serverUri = serverUri;
        this.robotId = robotId;
        this.objectMapper = new ObjectMapper();
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
    }

    public void start() {
        log.info("Starting Java Robot WSS Client for [{}] target: {}", robotId, serverUri);
        Executors.newSingleThreadExecutor().submit(this::connectLoop);
    }

    private void connectLoop() {
        while (running) {
            try {
                log.info("Connecting to WSS endpoint [{}]...", serverUri);
                CompletableFuture<WebSocket> future = httpClient.newWebSocketBuilder()
                        .buildAsync(URI.create(serverUri), this);
                
                this.webSocket = future.get();
                log.info("WSS Connection Established for robot [{}]!", robotId);

                // Run telemetry reporting loop until socket closes
                sendTelemetryLoop();

            } catch (Exception e) {
                log.warn("WSS Connection failed or lost for [{}]: {}. Retrying in 3 seconds...", robotId, e.getMessage());
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        }
    }

    private void sendTelemetryLoop() {
        while (running && webSocket != null && !webSocket.isOutputClosed()) {
            try {
                // Simulate slight movement for telemetry
                currentX += 0.05;
                currentY += 0.02;

                RobotTelemetryPacket packet = RobotTelemetryPacket.builder()
                        .source("robot")
                        .type("TELEMETRY")
                        .robotId(robotId)
                        .location(new LocationDto(currentX, currentY, currentYaw))
                        .battery(91.5)
                        .status("AUTO_PATROL")
                        .timestamp(System.currentTimeMillis() / 1000)
                        .build();

                String json = objectMapper.writeValueAsString(packet);
                webSocket.sendText(json, true);
                log.debug("Sent Telemetry WSS Frame: {}", json);

                Thread.sleep(1000); // 1-second telemetry interval
            } catch (InterruptedException e) {
                break;
            } catch (Exception e) {
                log.error("Error sending telemetry frame: {}", e.getMessage());
                break;
            }
        }
    }

    public void sendFireEvent(double confidence, double temperature) {
        if (webSocket == null || webSocket.isOutputClosed()) {
            log.warn("Cannot send fire event. WSS connection not active.");
            return;
        }

        try {
            RobotFireEventPacket packet = RobotFireEventPacket.builder()
                    .source("robot")
                    .type("EVENT_FIRE")
                    .robotId(robotId)
                    .confidence(confidence)
                    .temperature(temperature)
                    .location(new LocationDto(currentX, currentY, currentYaw))
                    .timestamp(System.currentTimeMillis() / 1000)
                    .build();

            String json = objectMapper.writeValueAsString(packet);
            webSocket.sendText(json, true);
            log.info("FIRE EVENT Sent via WSS: {}", json);
        } catch (Exception e) {
            log.error("Failed to send fire event: {}", e.getMessage(), e);
        }
    }

    @Override
    public void onOpen(WebSocket webSocket) {
        log.info("WSS Session Opened: {}", webSocket.getSubprotocol());
        WebSocket.Listener.super.onOpen(webSocket);
    }

    @Override
    public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
        String payload = data.toString();
        log.info(" Received WSS Command from Server: {}", payload);

        try {
            JsonNode root = objectMapper.readTree(payload);
            String command = root.path("command").asText(null);

            if ("DRIVE".equalsIgnoreCase(command)) {
                double linear = root.path("linear").asDouble(0.0);
                double angular = root.path("angular").asDouble(0.0);
                log.info(">> ROS 2 Relay: /cmd_vel -> linear={}, angular={}", linear, angular);
            } else if ("SET_MODE".equalsIgnoreCase(command)) {
                String mode = root.path("mode").asText("AUTO_PATROL");
                log.info(">> ROS 2 Relay: FSM Mode Changed to -> {}", mode);
            } else if ("DISPATCH".equalsIgnoreCase(command)) {
                JsonNode targetLoc = root.path("target_location");
                log.info(">> ROS 2 Relay: Emergency Dispatch to Target Location -> {}", targetLoc);
            }
        } catch (Exception e) {
            log.error("Failed to parse downstream command: {}", payload, e);
        }

        return WebSocket.Listener.super.onText(webSocket, data, last);
    }

    @Override
    public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
        log.warn("WSS Connection Closed by Server. Code: {}, Reason: {}", statusCode, reason);
        return WebSocket.Listener.super.onClose(webSocket, statusCode, reason);
    }

    @Override
    public void onError(WebSocket webSocket, Throwable error) {
        log.error("WSS Transport Error: {}", error.getMessage());
        WebSocket.Listener.super.onError(webSocket, error);
    }

    public void stop() {
        this.running = false;
        if (webSocket != null) {
            webSocket.sendClose(WebSocket.NORMAL_CLOSURE, "Stopping Client");
        }
    }
}
