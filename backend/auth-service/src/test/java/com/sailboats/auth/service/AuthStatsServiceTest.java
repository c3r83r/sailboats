package com.sailboats.auth.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.sailboats.auth.repo.UserRepository;
import java.time.OffsetDateTime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class AuthStatsServiceTest {

    @Mock
    private UserRepository userRepository;

    @Test
    void publicStatsCountsRegisteredAndRecentlyActiveUsers() {
        when(userRepository.countRegisteredUsers()).thenReturn(42L);
        when(userRepository.countActiveUsersSince(any())).thenReturn(7L);

        AuthStatsService service = new AuthStatsService(userRepository, 24);

        var stats = service.publicStats();

        assertThat(stats.registeredUsers()).isEqualTo(42L);
        assertThat(stats.activeUsers()).isEqualTo(7L);
        assertThat(stats.activeWindowHours()).isEqualTo(24L);

        ArgumentCaptor<OffsetDateTime> sinceCaptor = ArgumentCaptor.forClass(OffsetDateTime.class);
        verify(userRepository).countActiveUsersSince(sinceCaptor.capture());
        assertThat(sinceCaptor.getValue()).isAfter(OffsetDateTime.now().minusHours(25));
    }
}