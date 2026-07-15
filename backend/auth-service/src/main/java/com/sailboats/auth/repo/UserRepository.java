package com.sailboats.auth.repo;

import com.sailboats.auth.domain.UserEntity;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.repository.query.Param;

public interface UserRepository extends JpaRepository<UserEntity, UUID> {

    Optional<UserEntity> findByEmail(String email);

    boolean existsByEmail(String email);

    @Query("select count(u) from UserEntity u")
    long countRegisteredUsers();

    @Query("select count(u) from UserEntity u where coalesce(u.lastActiveAt, u.createdAt) >= :since")
    long countActiveUsersSince(@Param("since") OffsetDateTime since);
}
