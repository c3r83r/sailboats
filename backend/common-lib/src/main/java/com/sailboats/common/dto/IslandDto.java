package com.sailboats.common.dto;

import java.util.List;

import lombok.Builder;

@Builder
public record IslandDto(
    String id,
    List<PointDto> points
) {
}
