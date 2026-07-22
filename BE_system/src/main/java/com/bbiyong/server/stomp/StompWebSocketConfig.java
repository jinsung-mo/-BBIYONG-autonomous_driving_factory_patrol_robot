package com.bbiyong.server.stomp;

import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;

@Configuration
@EnableWebSocketMessageBroker
public class StompWebSocketConfig implements WebSocketMessageBrokerConfigurer {

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        // Topic prefixes for broadcasting to Web Observation Dashboard
        registry.enableSimpleBroker("/topic");
        // Application prefix for incoming messages from Web Observation Dashboard
        registry.setApplicationDestinationPrefixes("/app");
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        // Web Observation Dashboard STOMP WSS endpoint (supporting both Korean and ASCII paths)
        registry.addEndpoint("/ws-관제", "/ws/control")
                .setAllowedOrigins("*");
    }
}
