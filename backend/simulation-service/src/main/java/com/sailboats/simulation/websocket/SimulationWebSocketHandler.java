package com.sailboats.simulation.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.model.ControlInput;
import com.sailboats.simulation.service.SimulationEngine;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class SimulationWebSocketHandler extends TextWebSocketHandler {

    private final ObjectMapper objectMapper;
    private final SimulationEngine simulationEngine;
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    public SimulationWebSocketHandler(ObjectMapper objectMapper, SimulationEngine simulationEngine) {
        this.objectMapper = objectMapper;
        this.simulationEngine = simulationEngine;
        this.simulationEngine.addSnapshotListener(this::broadcastSnapshot);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String boatId = "boat-" + session.getId();
        session.getAttributes().put("boatId", boatId);
        sessions.put(session.getId(), session);
        simulationEngine.upsertBoat(boatId);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String boatId = (String) session.getAttributes().get("boatId");
        if (boatId == null) {
            return;
        }

        ControlPayload payload = objectMapper.readValue(message.getPayload(), ControlPayload.class);
        if ("fire".equals(payload.type())) {
            simulationEngine.fire(boatId, payload.side(), payload.power());
        } else {
            simulationEngine.updateControls(
                new ControlInput(boatId, payload.rudder(), payload.sailTrim(), payload.anchored()));
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session.getId());
        String boatId = (String) session.getAttributes().get("boatId");
        if (boatId != null) {
            simulationEngine.removeBoat(boatId);
        }
    }

    private void broadcastSnapshot(SimulationSnapshotDto snapshot) {
        try {
            for (WebSocketSession session : sessions.values()) {
                if (session.isOpen()) {
                    String boatId = (String) session.getAttributes().get("boatId");
                    Map<String, Object> envelope = new HashMap<>();
                    envelope.put("serverTime", snapshot.serverTime());
                    envelope.put("windDirection", snapshot.windDirection());
                    envelope.put("windStrength", snapshot.windStrength());
                    envelope.put("boats", snapshot.boats());
                    envelope.put("projectiles", snapshot.projectiles());
                    envelope.put("yourBoatId", boatId);
                    session.sendMessage(new TextMessage(objectMapper.writeValueAsString(envelope)));
                }
            }
        } catch (IOException ex) {
            // Intentionally swallow transport-level exceptions to keep simulation loop stable.
        }
    }

    private record ControlPayload(String type, double rudder, double sailTrim, boolean anchored, String side, double power) {
    }
}
