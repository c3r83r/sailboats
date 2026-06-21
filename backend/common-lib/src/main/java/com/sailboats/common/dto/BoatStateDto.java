package com.sailboats.common.dto;

import lombok.Builder;

@Builder
public record BoatStateDto(
    String boatId,
    String name,
    double x,
    double y,
    double heading,
    double speed,
    double rudder,
    double sailTrim,
    boolean anchored,
    double health,
    boolean sunk,
    int kills,
    int deaths,
    boolean bot
) {
}
