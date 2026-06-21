package com.sailboats.common.dto;

import lombok.Builder;

@Builder
public record ProjectileDto(
    String id,
    String ownerId,
    double x,
    double y
) {
}
