package com.sailboats.common.dto;

import java.util.List;

import lombok.Builder;

@Builder(toBuilder = true)
public record SimulationSnapshotDto(
    long serverTime,
    double windDirection,
    double windStrength,
    List<BoatStateDto> boats,
    List<ProjectileDto> projectiles,
    List<BuoyDto> buoys,
    List<IslandDto> islands,
    String lakeId,
    String lakeName,
    double worldWidth,
    double worldHeight,
    int lakeBoats,
    int lakeCapacity,
    int lakeTotal
) {
}
