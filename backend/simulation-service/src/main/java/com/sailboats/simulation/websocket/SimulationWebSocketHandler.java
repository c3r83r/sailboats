package com.sailboats.simulation.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.domain.LakeSize;
import com.sailboats.simulation.model.ControlInput;
import com.sailboats.simulation.service.SimulationEngine;
import java.io.IOException;
import java.util.HashMap;
import java.util.List;
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
    private volatile List<SimulationEngine.LakeSummary> cachedLakes = List.of();
    private volatile long cachedLakesAt = 0;

    public SimulationWebSocketHandler(ObjectMapper objectMapper, SimulationEngine simulationEngine) {
        this.objectMapper = objectMapper;
        this.simulationEngine = simulationEngine;
        this.simulationEngine.addSnapshotListener(this::broadcastSnapshots);
    }

    public long countOnlineUsers() {
        return sessions.values().stream()
            .filter(WebSocketSession::isOpen)
            .map(session -> session.getAttributes().get("userId"))
            .filter(java.util.Objects::nonNull)
            .map(Object::toString)
            .distinct()
            .count();
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
        } else if ("joinLake".equals(payload.type())) {
            String lakeId = simulationEngine.joinExistingLake(boatId, payload.lakeId());
            session.getAttributes().put("lakeId", lakeId);
        } else if ("createLake".equals(payload.type())) {
            LakeSize size = LakeSize.fromString(payload.size(), LakeSize.SMALL);
            String lakeId = simulationEngine.createAndJoinLake(
                boatId, size, payload.bots(), payload.windDirection(), payload.name());
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
            // The lake list changes slowly; refresh it at most once a second instead
            // of hitting the DB on every 20 fps broadcast.
            long now = System.currentTimeMillis();
            if (now - cachedLakesAt > 1000) {
                cachedLakes = simulationEngine.listLakeSummaries();
                cachedLakesAt = now;
            }
            List<SimulationEngine.LakeSummary> lakeList = cachedLakes;
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
                // Islands are static and can be large on big lakes: send them once
                // per lake, then let the client keep the last set it received.
                String islandsSentFor = (String) session.getAttributes().get("islandsLakeSent");
                if (!lakeId.equals(islandsSentFor)) {
                    envelope.put("islands", snapshot.islands());
                    session.getAttributes().put("islandsLakeSent", lakeId);
                }
                envelope.put("yourBoatId", boatId);
                envelope.put("worldWidth", snapshot.worldWidth());
                envelope.put("worldHeight", snapshot.worldHeight());
                envelope.put("lakeId", snapshot.lakeId());
                envelope.put("lakeName", snapshot.lakeName());
                envelope.put("lakeBoats", snapshot.lakeBoats());
                envelope.put("lakeCapacity", snapshot.lakeCapacity());
                envelope.put("lakeTotal", snapshot.lakeTotal());
                envelope.put("lakes", lakeList);
                session.sendMessage(new TextMessage(objectMapper.writeValueAsString(envelope)));
            }
        } catch (IOException ex) {
            // Intentionally swallow transport-level exceptions to keep simulation loop stable.
        }
    }

    private record ControlPayload(String type, double rudder, double sailTrim, boolean anchored, String side,
                                  double power, String lakeId, String size, boolean bots, Double windDirection,
                                  String name) {
    }
}
