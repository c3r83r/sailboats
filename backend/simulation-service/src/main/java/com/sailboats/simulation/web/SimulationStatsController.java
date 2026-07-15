package com.sailboats.simulation.web;

import com.sailboats.simulation.web.dto.PublicSimulationStatsDto;
import com.sailboats.simulation.websocket.SimulationWebSocketHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.CrossOrigin;

@RestController
@RequestMapping("/api/simulation/public")
@CrossOrigin(origins = "${app.cors.allowed-origins:*}")
public class SimulationStatsController {

    private final SimulationWebSocketHandler simulationWebSocketHandler;

    public SimulationStatsController(SimulationWebSocketHandler simulationWebSocketHandler) {
        this.simulationWebSocketHandler = simulationWebSocketHandler;
    }

    @GetMapping("/stats")
    public PublicSimulationStatsDto stats() {
        return new PublicSimulationStatsDto(simulationWebSocketHandler.countOnlineUsers());
    }
}