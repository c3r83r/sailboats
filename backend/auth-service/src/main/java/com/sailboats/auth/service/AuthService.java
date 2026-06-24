package com.sailboats.auth.service;

import com.sailboats.auth.domain.RefreshTokenEntity;
import com.sailboats.auth.domain.UserEntity;
import com.sailboats.auth.repo.RefreshTokenRepository;
import com.sailboats.auth.repo.UserRepository;
import com.sailboats.auth.security.JwtService;
import com.sailboats.auth.web.dto.AuthResponse;
import com.sailboats.auth.web.dto.UserDto;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.HexFormat;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AuthService {

    private final UserRepository userRepository;
    private final RefreshTokenRepository refreshTokenRepository;
    private final PasswordEncoder passwordEncoder;
    private final JwtService jwtService;
    private final long refreshTtlSeconds;
    private final SecureRandom secureRandom = new SecureRandom();

    public AuthService(UserRepository userRepository,
                       RefreshTokenRepository refreshTokenRepository,
                       PasswordEncoder passwordEncoder,
                       JwtService jwtService,
                       @org.springframework.beans.factory.annotation.Value("${app.refresh.ttl-days}") long refreshTtlDays) {
        this.userRepository = userRepository;
        this.refreshTokenRepository = refreshTokenRepository;
        this.passwordEncoder = passwordEncoder;
        this.jwtService = jwtService;
        this.refreshTtlSeconds = refreshTtlDays * 24 * 3600;
    }

    /** Access token + raw (un-hashed) refresh token to hand back to the client. */
    public record AuthResult(AuthResponse response, String refreshToken) {
    }

    @Transactional
    public AuthResult register(String email, String rawPassword, String displayName) {
        String normalizedEmail = email.trim().toLowerCase();
        if (userRepository.existsByEmail(normalizedEmail)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Email already in use");
        }
        UserEntity user = new UserEntity();
        user.setId(UUID.randomUUID());
        user.setEmail(normalizedEmail);
        user.setPasswordHash(passwordEncoder.encode(rawPassword));
        user.setDisplayName(displayName.trim());
        user.setCreatedAt(OffsetDateTime.now());
        userRepository.save(user);
        return issueTokens(user);
    }

    @Transactional
    public AuthResult login(String email, String rawPassword) {
        UserEntity user = userRepository.findByEmail(email.trim().toLowerCase())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials"));
        if (!passwordEncoder.matches(rawPassword, user.getPasswordHash())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid credentials");
        }
        return issueTokens(user);
    }

    @Transactional
    public AuthResult refresh(String rawRefreshToken) {
        if (rawRefreshToken == null || rawRefreshToken.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Missing refresh token");
        }
        RefreshTokenEntity stored = refreshTokenRepository.findByTokenHash(hash(rawRefreshToken))
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid refresh token"));
        if (stored.isRevoked() || stored.getExpiresAt().isBefore(OffsetDateTime.now())) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Expired refresh token");
        }
        // Rotate: the old token can never be reused.
        stored.setRevoked(true);
        refreshTokenRepository.save(stored);
        UserEntity user = userRepository.findById(stored.getUserId())
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unknown user"));
        return issueTokens(user);
    }

    @Transactional
    public void logout(String rawRefreshToken) {
        if (rawRefreshToken == null || rawRefreshToken.isBlank()) {
            return;
        }
        refreshTokenRepository.findByTokenHash(hash(rawRefreshToken)).ifPresent(token -> {
            token.setRevoked(true);
            refreshTokenRepository.save(token);
        });
    }

    private AuthResult issueTokens(UserEntity user) {
        String accessToken = jwtService.issueAccessToken(user);
        String rawRefresh = generateRefreshToken();

        RefreshTokenEntity entity = new RefreshTokenEntity();
        entity.setId(UUID.randomUUID());
        entity.setUserId(user.getId());
        entity.setTokenHash(hash(rawRefresh));
        entity.setExpiresAt(OffsetDateTime.now().plusSeconds(refreshTtlSeconds));
        entity.setRevoked(false);
        entity.setCreatedAt(OffsetDateTime.now());
        refreshTokenRepository.save(entity);

        UserDto userDto = new UserDto(user.getId().toString(), user.getEmail(), user.getDisplayName());
        AuthResponse response = new AuthResponse(accessToken, jwtService.getAccessTtlSeconds(), userDto);
        return new AuthResult(response, rawRefresh);
    }

    public long getRefreshTtlSeconds() {
        return refreshTtlSeconds;
    }

    private String generateRefreshToken() {
        byte[] bytes = new byte[32];
        secureRandom.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private String hash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] out = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(out);
        } catch (Exception ex) {
            throw new IllegalStateException("SHA-256 not available", ex);
        }
    }
}
