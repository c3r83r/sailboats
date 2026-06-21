package com.sailboats.common.dto;

import lombok.Builder;

@Builder
public record PointDto(
    double x,
    double y
) {
}
