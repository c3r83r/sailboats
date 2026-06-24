package com.sailboats.simulation.config;

import com.sailboats.simulation.security.AuthHandshakeInterceptor;
import com.sailboats.simulation.websocket.SimulationWebSocketHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final SimulationWebSocketHandler simulationWebSocketHandler;
    private final AuthHandshakeInterceptor authHandshakeInterceptor;
    private final String[] allowedOriginPatterns;

    public WebSocketConfig(SimulationWebSocketHandler simulationWebSocketHandler,
                           AuthHandshakeInterceptor authHandshakeInterceptor,
                           @Value("${app.cors.allowed-origins:*}") String allowedOrigins) {
        this.simulationWebSocketHandler = simulationWebSocketHandler;
        this.authHandshakeInterceptor = authHandshakeInterceptor;
        this.allowedOriginPatterns = parseOrigins(allowedOrigins);
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(simulationWebSocketHandler, "/ws/simulation")
            .addInterceptors(authHandshakeInterceptor)
            .setAllowedOriginPatterns(allowedOriginPatterns);
    }

    private static String[] parseOrigins(String allowedOrigins) {
        if (allowedOrigins == null || allowedOrigins.isBlank()) {
            return new String[] {"*"};
        }
        return java.util.Arrays.stream(allowedOrigins.split(","))
            .map(String::trim)
            .filter(origin -> !origin.isEmpty())
            .toArray(String[]::new);
    }
}
