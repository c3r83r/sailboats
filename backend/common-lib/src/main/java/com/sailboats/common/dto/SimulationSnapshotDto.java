package com.sailboats.common.dto;

import java.util.List;

import lombok.Builder;

@Builder
public record SimulationSnapshotDto(
    long serverTime,
    double windDirection,
    double windStrength,
    List<BoatStateDto> boats,
    List<ProjectileDto> projectiles
) {
}
