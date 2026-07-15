package com.sailboats.auth.web;

import com.sailboats.auth.repo.UserRepository;
import com.sailboats.auth.security.JwtService;
import com.sailboats.auth.service.AuthService;
import com.sailboats.auth.service.AuthStatsService;
import com.sailboats.auth.web.dto.AuthResponse;
import com.sailboats.auth.web.dto.LoginRequest;
import com.sailboats.auth.web.dto.PublicStatsDto;
import com.sailboats.auth.web.dto.RegisterRequest;
import com.sailboats.auth.web.dto.UserDto;
import jakarta.validation.Valid;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private static final String REFRESH_COOKIE = "refresh_token";

    private final AuthService authService;
    private final AuthStatsService authStatsService;
    private final JwtService jwtService;
    private final UserRepository userRepository;
    private final boolean cookieSecure;
    private final String cookieSameSite;

    public AuthController(AuthService authService,
                          AuthStatsService authStatsService,
                          JwtService jwtService,
                          UserRepository userRepository,
                          @Value("${app.cookie.secure:false}") boolean cookieSecure,
                          @Value("${app.cookie.same-site:Lax}") String cookieSameSite) {
        this.authService = authService;
        this.authStatsService = authStatsService;
        this.jwtService = jwtService;
        this.userRepository = userRepository;
        this.cookieSecure = cookieSecure;
        this.cookieSameSite = cookieSameSite;
    }

    @PostMapping("/register")
    public ResponseEntity<AuthResponse> register(@Valid @RequestBody RegisterRequest request) {
        AuthService.AuthResult result = authService.register(request.email(), request.password(), request.displayName());
        return ResponseEntity.status(HttpStatus.CREATED)
            .header(HttpHeaders.SET_COOKIE, refreshCookie(result.refreshToken(), authService.getRefreshTtlSeconds()))
            .body(result.response());
    }

    @PostMapping("/login")
    public ResponseEntity<AuthResponse> login(@Valid @RequestBody LoginRequest request) {
        AuthService.AuthResult result = authService.login(request.email(), request.password());
        return ResponseEntity.ok()
            .header(HttpHeaders.SET_COOKIE, refreshCookie(result.refreshToken(), authService.getRefreshTtlSeconds()))
            .body(result.response());
    }

    @PostMapping("/refresh")
    public ResponseEntity<AuthResponse> refresh(@CookieValue(name = REFRESH_COOKIE, required = false) String refreshToken) {
        AuthService.AuthResult result = authService.refresh(refreshToken);
        return ResponseEntity.ok()
            .header(HttpHeaders.SET_COOKIE, refreshCookie(result.refreshToken(), authService.getRefreshTtlSeconds()))
            .body(result.response());
    }

    @PostMapping("/logout")
    public ResponseEntity<Void> logout(@CookieValue(name = REFRESH_COOKIE, required = false) String refreshToken) {
        authService.logout(refreshToken);
        return ResponseEntity.noContent()
            .header(HttpHeaders.SET_COOKIE, refreshCookie("", 0))
            .build();
    }

    @GetMapping("/me")
    public UserDto me(@RequestHeader(name = "Authorization", required = false) String authorization) {
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Missing bearer token");
        }
        String subject;
        try {
            subject = jwtService.subjectOf(authorization.substring(7));
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Invalid token");
        }
        return userRepository.findById(UUID.fromString(subject))
            .map(user -> new UserDto(user.getId().toString(), user.getEmail(), user.getDisplayName()))
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unknown user"));
    }

    @GetMapping("/public/stats")
    public PublicStatsDto publicStats() {
        return authStatsService.publicStats();
    }

    private String refreshCookie(String value, long maxAgeSeconds) {
        return ResponseCookie.from(REFRESH_COOKIE, value)
            .httpOnly(true)
            .secure(cookieSecure)
            .sameSite(cookieSameSite)
            .path("/api/auth")
            .maxAge(maxAgeSeconds)
            .build()
            .toString();
    }
}
