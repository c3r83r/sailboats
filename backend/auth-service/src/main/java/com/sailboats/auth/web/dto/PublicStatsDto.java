package com.sailboats.auth.web.dto;

public record PublicStatsDto(long registeredUsers, long activeUsers, long activeWindowHours) {
}