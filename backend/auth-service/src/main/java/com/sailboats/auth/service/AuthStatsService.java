package com.sailboats.auth.service;

import com.sailboats.auth.repo.UserRepository;
import com.sailboats.auth.web.dto.PublicStatsDto;
import java.time.OffsetDateTime;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class AuthStatsService {

    private final UserRepository userRepository;
    private final long activeWindowHours;

    public AuthStatsService(UserRepository userRepository,
                            @Value("${app.stats.active-window-hours:24}") long activeWindowHours) {
        this.userRepository = userRepository;
        this.activeWindowHours = activeWindowHours;
    }

    public PublicStatsDto publicStats() {
        OffsetDateTime since = OffsetDateTime.now().minusHours(activeWindowHours);
        return new PublicStatsDto(
            userRepository.countRegisteredUsers(),
            userRepository.countActiveUsersSince(since),
            activeWindowHours
        );
    }
}