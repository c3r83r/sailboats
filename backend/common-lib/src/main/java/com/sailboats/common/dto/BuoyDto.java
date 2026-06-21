package com.sailboats.common.dto;

import lombok.Builder;

@Builder
public record BuoyDto(
    String id,
    double x,
    double y
) {
}
