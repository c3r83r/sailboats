package com.sailboats.simulation.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.model.ControlInput;
import com.sailboats.simulation.service.SimulationEngine;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class SimulationWebSocketHandler extends TextWebSocketHandler {

    // Keep a disconnected player's boat alive briefly so a tab refresh/switch resumes it.
    private static final long RECONNECT_GRACE_SECONDS = 45;

    private final ObjectMapper objectMapper;
    private final SimulationEngine simulationEngine;
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    private final Map<String, ScheduledFuture<?>> pendingRemovals = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "ws-reconnect-grace");
        t.setDaemon(true);
        return t;
    });

    public SimulationWebSocketHandler(ObjectMapper objectMapper, SimulationEngine simulationEngine) {
        this.objectMapper = objectMapper;
        this.simulationEngine = simulationEngine;
        this.simulationEngine.addSnapshotListener(this::broadcastSnapshots);
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        // userId/userName are set by AuthHandshakeInterceptor after validating the token.
        String userId = (String) session.getAttributes().get("userId");
        String name = (String) session.getAttributes().get("userName");
        String boatId = "user-" + userId;
        session.getAttributes().put("boatId", boatId);
        sessions.put(session.getId(), session);

        // A reconnect within the grace window resumes the same boat instead of spawning a new one.
        cancelPendingRemoval(boatId);
        String lakeId = simulationEngine.isAssigned(boatId)
            ? simulationEngine.lakeOf(boatId)
            : simulationEngine.assignBoat(boatId, name);
        session.getAttributes().put("lakeId", lakeId);
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
        if (boatId == null) {
            return;
        }
        // If the player still has another open tab, keep the boat as-is.
        if (hasOpenSession(boatId)) {
            return;
        }
        scheduleRemoval(boatId);
    }

    private void scheduleRemoval(String boatId) {
        ScheduledFuture<?> future = scheduler.schedule(() -> {
            pendingRemovals.remove(boatId);
            if (!hasOpenSession(boatId)) {
                simulationEngine.removeBoat(boatId);
            }
        }, RECONNECT_GRACE_SECONDS, TimeUnit.SECONDS);
        ScheduledFuture<?> previous = pendingRemovals.put(boatId, future);
        if (previous != null) {
            previous.cancel(false);
        }
    }

    private void cancelPendingRemoval(String boatId) {
        ScheduledFuture<?> future = pendingRemovals.remove(boatId);
        if (future != null) {
            future.cancel(false);
        }
    }

    private boolean hasOpenSession(String boatId) {
        return sessions.values().stream()
            .anyMatch(s -> s.isOpen() && boatId.equals(s.getAttributes().get("boatId")));
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
