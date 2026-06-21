package com.sailboats.simulation.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.model.ControlInput;
import com.sailboats.simulation.service.SimulationEngine;
import java.io.IOException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
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
        this.simulationEngine.addSnapshotListener(this::broadcastSnapshots);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String boatId = "boat-" + session.getId();
        session.getAttributes().put("boatId", boatId);
        sessions.put(session.getId(), session);
        // Drop the new boat onto a lake with a free slot (or a brand-new one).
        String lakeId = simulationEngine.assignBoat(boatId, extractNick(session));
        session.getAttributes().put("lakeId", lakeId);
    }

    // Pull the player's chosen nickname from the handshake query (?nick=...).
    private String extractNick(WebSocketSession session) {
        if (session.getUri() == null) {
            return null;
        }
        String query = session.getUri().getQuery();
        if (query == null) {
            return null;
        }
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && "nick".equals(pair.substring(0, eq))) {
                return URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
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
        } else if ("changeLake".equals(payload.type())) {
            String lakeId = simulationEngine.changeLake(boatId);
            session.getAttributes().put("lakeId", lakeId);
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

    private void broadcastSnapshots(Map<String, SimulationSnapshotDto> snapshotsByLake) {
        try {
            for (WebSocketSession session : sessions.values()) {
                if (!session.isOpen()) {
                    continue;
                }
                String lakeId = (String) session.getAttributes().get("lakeId");
                if (lakeId == null) {
                    continue;
                }
                SimulationSnapshotDto snapshot = snapshotsByLake.get(lakeId);
                if (snapshot == null) {
                    continue;
                }
                String boatId = (String) session.getAttributes().get("boatId");
                Map<String, Object> envelope = new HashMap<>();
                envelope.put("serverTime", snapshot.serverTime());
                envelope.put("windDirection", snapshot.windDirection());
                envelope.put("windStrength", snapshot.windStrength());
                envelope.put("boats", snapshot.boats());
                envelope.put("projectiles", snapshot.projectiles());
                envelope.put("buoys", snapshot.buoys());
                envelope.put("islands", snapshot.islands());
                envelope.put("yourBoatId", boatId);
                envelope.put("lakeId", snapshot.lakeId());
                envelope.put("lakeName", snapshot.lakeName());
                envelope.put("lakeBoats", snapshot.lakeBoats());
                envelope.put("lakeCapacity", snapshot.lakeCapacity());
                envelope.put("lakeTotal", snapshot.lakeTotal());
                session.sendMessage(new TextMessage(objectMapper.writeValueAsString(envelope)));
            }
        } catch (IOException ex) {
            // Intentionally swallow transport-level exceptions to keep simulation loop stable.
        }
    }

    private record ControlPayload(String type, double rudder, double sailTrim, boolean anchored, String side, double power) {
    }
}
