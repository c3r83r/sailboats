package com.sailboats.telemetry.web;

import com.sailboats.telemetry.domain.TelemetryEventEntity;
import com.sailboats.telemetry.repository.TelemetryEventRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequiredArgsConstructor
@RequestMapping("/api/telemetry/events")
public class TelemetryController {

    private final TelemetryEventRepository telemetryEventRepository;

    @GetMapping
    public List<TelemetryEventEntity> all() {
        return telemetryEventRepository.findAll();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public TelemetryEventEntity create(@RequestBody @Valid CreateTelemetryEventRequest request) {
        TelemetryEventEntity entity = new TelemetryEventEntity();
        entity.setBoatId(request.boatId());
        entity.setEventType(request.eventType());
        entity.setPayload(request.payload());
        entity.setCreatedAt(Instant.now());
        return telemetryEventRepository.save(entity);
    }

    public record CreateTelemetryEventRequest(
        @NotBlank String boatId,
        @NotBlank String eventType,
        @NotBlank String payload
    ) {
    }
}
