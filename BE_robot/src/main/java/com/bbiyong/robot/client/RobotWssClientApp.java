package com.bbiyong.robot.client;

import lombok.extern.slf4j.Slf4j;

@Slf4j
public class RobotWssClientApp {

    public static void main(String[] args) {
        String serverUri = System.getProperty("wss.uri", "ws://localhost:8080/ws/robot");
        String robotId = System.getProperty("robot.id", "orinka_01");

        if (args.length > 0) {
            serverUri = args[0];
        }
        if (args.length > 1) {
            robotId = args[1];
        }

        log.info("==============================================");
        log.info(" Starting BBIYONG Robot WSS Client Module");
        log.info(" Target Server: {}", serverUri);
        log.info(" Robot ID:      {}", robotId);
        log.info("==============================================");

        RobotWssClient client = new RobotWssClient(serverUri, robotId);
        client.start();

        // Keep main thread alive
        try {
            Thread.currentThread().join();
        } catch (InterruptedException e) {
            log.info("Robot WSS Client Application stopped.");
            client.stop();
        }
    }
}
