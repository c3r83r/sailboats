package com.sailboats.telemetry.repository;

import com.sailboats.telemetry.domain.TelemetryEventEntity;
import org.springframework.data.jpa.repository.JpaRepository;

public interface TelemetryEventRepository extends JpaRepository<TelemetryEventEntity, Long> {
}
