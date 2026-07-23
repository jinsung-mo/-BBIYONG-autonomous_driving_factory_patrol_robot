package com.bbiyong.server.tcp;

import com.bbiyong.server.tcp.dto.RobotPacket;
import com.bbiyong.server.tcp.event.RobotFireEvent;
import com.bbiyong.server.tcp.event.RobotOverheatEvent;
import com.bbiyong.server.tcp.event.RobotTelemetryEvent;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.ApplicationEventPublisher;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

@Slf4j
public class TcpClientHandler implements Runnable {

    private final Socket socket;
    private final TcpSessionManager sessionManager;
    private final ObjectMapper objectMapper;
    private final ApplicationEventPublisher eventPublisher;

    private BufferedReader reader;
    private BufferedWriter writer;
    private String registeredRobotId;
    private volatile boolean running = true;

    public TcpClientHandler(Socket socket, TcpSessionManager sessionManager, 
                            ObjectMapper objectMapper, ApplicationEventPublisher eventPublisher) {
        this.socket = socket;
        this.sessionManager = sessionManager;
        this.objectMapper = objectMapper;
        this.eventPublisher = eventPublisher;
    }

    @Override
    public void run() {
        try {
            this.reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            this.writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));

            log.info("Client connected from: {}:{}", socket.getInetAddress(), socket.getPort());

            String line;
            while (running && (line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }
                handleMessage(line);
            }
        } catch (IOException e) {
            if (running) {
                log.error("Error in TCP client connection with {}: {}", 
                        registeredRobotId != null ? registeredRobotId : "unknown robot", e.getMessage());
            }
        } finally {
            close();
        }
    }

    private void handleMessage(String jsonLine) {
        try {
            RobotPacket packet = objectMapper.readValue(jsonLine, RobotPacket.class);
            if (packet == null) {
                return;
            }

            // Register session upon receiving first packet containing robot_id
            String robotId = packet.getRobotId();
            if (robotId != null && registeredRobotId == null) {
                this.registeredRobotId = robotId;
                sessionManager.register(robotId, this);
            }

            if (packet.getType() == null) {
                log.warn("Received packet with missing type: {}", jsonLine);
                return;
            }

            // Process packet type
            switch (packet.getType()) {
                case "TELEMETRY":
                    eventPublisher.publishEvent(new RobotTelemetryEvent(this, packet));
                    break;
                case "EVENT_FIRE":
                    log.info("Fire event received from {}: confidence={}, temp={}", 
                            robotId, packet.getConfidence(), packet.getTemperature());
                    eventPublisher.publishEvent(new RobotFireEvent(this, packet));
                    break;
                case "EVENT_OVERHEAT":
                    log.info("Overheat event received from {} for equipment {}: temp={}", 
                            robotId, packet.getEquipmentId(), packet.getTemperature());
                    eventPublisher.publishEvent(new RobotOverheatEvent(this, packet));
                    break;
                default:
                    log.warn("Unknown packet type: {} in message: {}", packet.getType(), jsonLine);
            }
        } catch (Exception e) {
            log.error("Failed to parse JSON Lines packet: {}, error: {}", jsonLine, e.getMessage());
        }
    }

    public synchronized void sendMessage(String message) throws IOException {
        if (writer == null) {
            throw new IOException("Writer not initialized");
        }
        // Downstream command also must end with a newline for JSON Lines protocol
        writer.write(message);
        if (!message.endsWith("\n")) {
            writer.write("\n");
        }
        writer.flush();
    }

    public synchronized void close() {
        if (!running) {
            return;
        }
        running = false;
        log.info("Closing TCP client connection for robot: {}", 
                registeredRobotId != null ? registeredRobotId : "unknown");

        if (registeredRobotId != null) {
            sessionManager.unregister(registeredRobotId);
        }

        try {
            if (reader != null) reader.close();
        } catch (IOException ignored) {}
        try {
            if (writer != null) writer.close();
        } catch (IOException ignored) {}
        try {
            if (socket != null && !socket.isClosed()) socket.close();
        } catch (IOException ignored) {}
    }
}
