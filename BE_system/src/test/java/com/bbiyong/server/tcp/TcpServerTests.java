package com.bbiyong.server.tcp;

import com.bbiyong.server.tcp.dto.RobotPacket;
import com.bbiyong.server.tcp.event.RobotTelemetryEvent;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import org.springframework.test.annotation.DirtiesContext;
import org.springframework.beans.factory.annotation.Value;
import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@org.springframework.context.annotation.Import(TcpServerTests.TestEventListener.class)
@DirtiesContext
public class TcpServerTests {

    @Autowired
    private TcpSessionManager sessionManager;

    @Value("${bbiyong.tcp.port:9000}")
    private int tcpPort;

    private static final BlockingQueue<RobotTelemetryEvent> telemetryEvents = new LinkedBlockingQueue<>();

    @org.springframework.boot.test.context.TestConfiguration
    public static class TestEventListener {
        @EventListener
        public void handleTelemetry(RobotTelemetryEvent event) {
            System.out.println("=== TEST EVENT LISTENER RECEIVED TELEMETRY EVENT: " + event.getPacket() + " ===");
            telemetryEvents.offer(event);
        }
    }

    @Test
    public void testTcpConnectionAndTelemetry() throws Exception {
        // Connect to the TCP Server on configured port
        Socket clientSocket = new Socket("localhost", tcpPort);
        
        BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(clientSocket.getOutputStream(), StandardCharsets.UTF_8));
        BufferedReader reader = new BufferedReader(new InputStreamReader(clientSocket.getInputStream(), StandardCharsets.UTF_8));

        // Send telemetry packet
        String telemetryPacket = "{\"source\": \"robot\", \"type\": \"TELEMETRY\", \"robot_id\": \"test_robot_01\", \"location\": {\"x\": 1.25, \"y\": 3.40, \"yaw\": 0.78}, \"battery\": 92.5, \"status\": \"AUTO_PATROL\"}\n";
        writer.write(telemetryPacket);
        writer.flush();

        // Verify event was received in Spring Context
        RobotTelemetryEvent event = telemetryEvents.poll(5, TimeUnit.SECONDS);
        assertThat(event).isNotNull();
        RobotPacket packet = event.getPacket();
        assertThat(packet.getRobotId()).isEqualTo("test_robot_01");
        assertThat(packet.getType()).isEqualTo("TELEMETRY");
        assertThat(packet.getBattery()).isEqualTo(92.5);
        assertThat(packet.getLocation().getX()).isEqualTo(1.25);

        // Verify session is registered in manager
        assertThat(sessionManager.isConnected("test_robot_01")).isTrue();

        // Send a command from server to client
        class TargetLocation {
            public double x = 15.0;
            public double y = 8.2;
        }
        class CommandPayload {
            public String command = "DISPATCH";
            public TargetLocation target_location = new TargetLocation();
        }
        
        boolean success = sessionManager.sendCommand("test_robot_01", new CommandPayload());
        assertThat(success).isTrue();

        // Read command on client socket
        String commandLine = reader.readLine();
        assertThat(commandLine).isNotNull();
        assertThat(commandLine).contains("\"command\":\"DISPATCH\"");
        assertThat(commandLine).contains("\"x\":15.0");

        clientSocket.close();
    }
}
