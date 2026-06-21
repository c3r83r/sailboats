package com.sailboats.fleet.repository;

import com.sailboats.fleet.domain.BoatEntity;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BoatRepository extends JpaRepository<BoatEntity, Long> {
}
