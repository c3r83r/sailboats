package com.sailboats.simulation.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.OffsetDateTime;
import java.util.UUID;
import lombok.Getter;
import lombok.Setter;

/**
 * A lake (akwen) is a self-contained room with its own simulation world. The
 * island layout is derived deterministically from {@code seed}, so a lake can
 * be rebuilt identically from this row without storing every polygon.
 */
@Getter
@Setter
@Entity
@Table(name = "lakes")
public class LakeEntity {

    @Id
    @Column(nullable = false)
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private long seed;

    @Column(nullable = false)
    private int capacity;

    @Column(nullable = false)
    private boolean active;

    @Column(name = "created_at", nullable = false)
    private OffsetDateTime createdAt;
}
