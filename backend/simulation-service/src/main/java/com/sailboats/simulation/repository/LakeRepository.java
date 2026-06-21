package com.sailboats.simulation.repository;

import com.sailboats.simulation.domain.LakeEntity;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LakeRepository extends JpaRepository<LakeEntity, UUID> {
}
