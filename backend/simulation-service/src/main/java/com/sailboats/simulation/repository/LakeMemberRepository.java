package com.sailboats.simulation.repository;

import com.sailboats.simulation.domain.LakeMemberEntity;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface LakeMemberRepository extends JpaRepository<LakeMemberEntity, String> {

    long countByLakeId(UUID lakeId);
}
