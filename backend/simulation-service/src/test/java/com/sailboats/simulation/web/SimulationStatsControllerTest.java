package com.sailboats.simulation.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import com.sailboats.simulation.web.dto.PublicSimulationStatsDto;
import com.sailboats.simulation.websocket.SimulationWebSocketHandler;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class SimulationStatsControllerTest {

    @Mock
    private SimulationWebSocketHandler simulationWebSocketHandler;

    @Test
    void statsReturnsLiveOnlineUsersCount() {
        when(simulationWebSocketHandler.countOnlineUsers()).thenReturn(3L);

        SimulationStatsController controller = new SimulationStatsController(simulationWebSocketHandler);

        PublicSimulationStatsDto stats = controller.stats();

        assertThat(stats.onlineUsers()).isEqualTo(3L);
    }
}