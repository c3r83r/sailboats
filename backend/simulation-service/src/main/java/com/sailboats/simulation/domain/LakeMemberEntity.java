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
 * Assignment of a connected boat (a live WebSocket session) to a lake. One row
 * per boat; the row is the source of truth for how full each lake is.
 */
@Getter
@Setter
@Entity
@Table(name = "lake_members")
public class LakeMemberEntity {

    @Id
    @Column(name = "boat_id", nullable = false)
    private String boatId;

    @Column(name = "lake_id", nullable = false)
    private UUID lakeId;

    @Column(name = "joined_at", nullable = false)
    private OffsetDateTime joinedAt;
}
