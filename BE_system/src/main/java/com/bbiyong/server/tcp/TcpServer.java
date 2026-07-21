package com.bbiyong.server.tcp;

import tools.jackson.databind.ObjectMapper;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Slf4j
@Component
public class TcpServer {

    private int port;
    private final TcpSessionManager sessionManager;
    private final ObjectMapper objectMapper;
    private final ApplicationEventPublisher eventPublisher;

    private ServerSocket serverSocket;
    private final ExecutorService executorService = Executors.newCachedThreadPool();
    private volatile boolean running = false;

    public TcpServer(@Value("${bbiyong.tcp.port:9000}") int port,
                     TcpSessionManager sessionManager,
                     ObjectMapper objectMapper,
                     ApplicationEventPublisher eventPublisher) {
        this.port = port;
        this.sessionManager = sessionManager;
        this.objectMapper = objectMapper;
        this.eventPublisher = eventPublisher;
    }

    public int getPort() {
        return this.port;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        try {
            this.serverSocket = new ServerSocket(port);
            this.port = serverSocket.getLocalPort();
            log.info("Embedded TCP Server is listening on port: {}", port);
            running = true;
            executorService.submit(this::listen);
        } catch (IOException e) {
            log.error("Failed to start Embedded TCP Server on port {}: {}", port, e.getMessage());
            throw new RuntimeException("Failed to bind TCP server socket", e);
        }
    }

    private void listen() {
        try {
            while (running) {
                Socket socket = serverSocket.accept();
                TcpClientHandler handler = new TcpClientHandler(socket, sessionManager, objectMapper, eventPublisher);
                executorService.submit(handler);
            }
        } catch (IOException e) {
            if (running) {
                log.error("Error in TCP server socket: {}", e.getMessage());
            }
        }
    }

    @PreDestroy
    public void stop() {
        if (!running) {
            return;
        }
        log.info("Stopping Embedded TCP Server...");
        running = false;

        try {
            if (serverSocket != null && !serverSocket.isClosed()) {
                serverSocket.close();
            }
        } catch (IOException e) {
            log.error("Failed to close TCP ServerSocket: {}", e.getMessage());
        }

        sessionManager.closeAll();
        executorService.shutdownNow();
        log.info("Embedded TCP Server stopped.");
    }
}
