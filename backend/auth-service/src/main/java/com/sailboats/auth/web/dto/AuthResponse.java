package com.sailboats.auth.web.dto;

public record AuthResponse(String accessToken, long expiresIn, UserDto user) {
}
