package com.sailboats.simulation.service;

import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.domain.LakeEntity;
import com.sailboats.simulation.domain.LakeMemberEntity;
import com.sailboats.simulation.model.ControlInput;
import com.sailboats.simulation.repository.LakeMemberRepository;
import com.sailboats.simulation.repository.LakeRepository;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Manages many {@link LakeWorld}s (akweny / rooms). Each connected boat lives on
 * exactly one lake; a lake holds at most {@link LakeEntity#getCapacity()} boats.
 *
 * <p>The lake registry and the boat-to-lake assignments are persisted in the
 * database (the source of truth for occupancy); the live physics runs in memory.
 * A single scheduler ticks every world and hands the per-lake snapshots to the
 * WebSocket layer, which routes each one to the right sessions.
 */
@Service
public class SimulationEngine {

    private static final int DEFAULT_CAPACITY = 5;

    private final LakeRepository lakeRepository;
    private final LakeMemberRepository memberRepository;

    private final Map<String, LakeWorld> worlds = new ConcurrentHashMap<>();
    private final Map<String, String> boatToLake = new ConcurrentHashMap<>();
    private final Map<String, String> boatNames = new ConcurrentHashMap<>();
    private final List<Consumer<Map<String, SimulationSnapshotDto>>> listeners = new ArrayList<>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    // Guards lake assignment so two joins can never overflow a lake's capacity.
    private final Object assignmentLock = new Object();

    public SimulationEngine(LakeRepository lakeRepository, LakeMemberRepository memberRepository) {
        this.lakeRepository = lakeRepository;
        this.memberRepository = memberRepository;
    }

    @PostConstruct
    @Transactional
    void start() {
        // In-memory worlds are empty after a restart, so clear stale assignments
        // and park every persisted lake as inactive until someone joins it again.
        memberRepository.deleteAllInBatch();
        List<LakeEntity> lakes = lakeRepository.findAll();
        for (LakeEntity lake : lakes) {
            lake.setActive(false);
        }
        lakeRepository.saveAll(lakes);

        scheduler.scheduleAtFixedRate(this::tick, 0, 50, TimeUnit.MILLISECONDS);
    }

    @PreDestroy
    void stop() {
        scheduler.shutdownNow();
    }

    public void addSnapshotListener(Consumer<Map<String, SimulationSnapshotDto>> listener) {
        listeners.add(listener);
    }

    private void tick() {
        try {
            long now = System.currentTimeMillis();
            int total = worlds.size();
            Map<String, SimulationSnapshotDto> snapshots = new HashMap<>(total * 2);
            for (LakeWorld world : worlds.values()) {
                SimulationSnapshotDto snap = world.tick(now).toBuilder()
                    .lakeTotal(total)
                    .build();
                snapshots.put(world.getLakeId(), snap);
            }
            for (Consumer<Map<String, SimulationSnapshotDto>> listener : listeners) {
                listener.accept(snapshots);
            }
        } catch (Throwable ex) {
            // A single uncaught Throwable would permanently cancel the scheduled
            // task, freezing every lake; log and keep ticking instead.
            System.err.println("[SimulationEngine] tick() threw unexpectedly: " + ex);
            ex.printStackTrace();
        }
    }

    /** Place a freshly connected boat on a lake and return that lake's id. */
    @Transactional
    public String assignBoat(String boatId, String name) {
        synchronized (assignmentLock) {
            boatNames.put(boatId, sanitizeName(name));
            LakeEntity lake = findLakeWithSpace(null).orElseGet(this::createLake);
            joinLake(boatId, lake);
            return lake.getId().toString();
        }
    }

    /** Move a boat to a different lake (or a brand-new one) and return its id. */
    @Transactional
    public String changeLake(String boatId) {
        synchronized (assignmentLock) {
            String currentId = boatToLake.get(boatId);
            UUID currentUuid = currentId != null ? UUID.fromString(currentId) : null;

            LakeEntity target = findLakeWithSpace(currentUuid).orElseGet(this::createLake);
            if (currentId != null && target.getId().toString().equals(currentId)) {
                // Nothing better available and we somehow matched ourselves: stay put.
                return currentId;
            }

            leaveCurrentLake(boatId);
            joinLake(boatId, target);
            return target.getId().toString();
        }
    }

    public void removeBoat(String boatId) {
        synchronized (assignmentLock) {
            leaveCurrentLake(boatId);
            boatNames.remove(boatId);
        }
    }

    public void updateControls(ControlInput input) {
        LakeWorld world = worldOf(input.boatId());
        if (world != null) {
            world.updateControls(input);
        }
    }

    public void fire(String boatId, String side, double power) {
        LakeWorld world = worldOf(boatId);
        if (world != null) {
            world.fire(boatId, side, power);
        }
    }

    private LakeWorld worldOf(String boatId) {
        String lakeId = boatToLake.get(boatId);
        return lakeId == null ? null : worlds.get(lakeId);
    }

    // Trim to a safe, bounded display name; fall back to a default when blank.
    private String sanitizeName(String raw) {
        if (raw == null) {
            return "Żeglarz";
        }
        String cleaned = raw.replaceAll("[\\p{Cntrl}]", "").trim();
        if (cleaned.isEmpty()) {
            return "Żeglarz";
        }
        return cleaned.length() > 20 ? cleaned.substring(0, 20) : cleaned;
    }

    // ---- Lake lifecycle (must be called while holding assignmentLock) -------

    // The fullest active lake that still has a free slot, optionally excluding one.
    private Optional<LakeEntity> findLakeWithSpace(UUID excludeId) {
        return lakeRepository.findAll().stream()
            .filter(LakeEntity::isActive)
            .filter(lake -> excludeId == null || !lake.getId().equals(excludeId))
            .filter(lake -> memberRepository.countByLakeId(lake.getId()) < lake.getCapacity())
            .max(Comparator.comparingLong(lake -> memberRepository.countByLakeId(lake.getId())));
    }

    private LakeEntity createLake() {
        LakeEntity lake = new LakeEntity();
        lake.setId(UUID.randomUUID());
        lake.setName("Akwen #" + (lakeRepository.count() + 1));
        lake.setSeed(ThreadLocalRandom.current().nextLong());
        lake.setCapacity(DEFAULT_CAPACITY);
        lake.setActive(true);
        lake.setCreatedAt(OffsetDateTime.now());
        return lakeRepository.save(lake);
    }

    private void joinLake(String boatId, LakeEntity lake) {
        if (!lake.isActive()) {
            lake.setActive(true);
            lakeRepository.save(lake);
        }
        LakeWorld world = worlds.computeIfAbsent(lake.getId().toString(),
            id -> new LakeWorld(id, lake.getName(), lake.getCapacity(), lake.getSeed()));
        world.addBoat(boatId, boatNames.getOrDefault(boatId, "Żeglarz"));
        boatToLake.put(boatId, lake.getId().toString());

        LakeMemberEntity member = new LakeMemberEntity();
        member.setBoatId(boatId);
        member.setLakeId(lake.getId());
        member.setJoinedAt(OffsetDateTime.now());
        memberRepository.save(member);
    }

    private void leaveCurrentLake(String boatId) {
        String lakeId = boatToLake.remove(boatId);
        memberRepository.deleteById(boatId);
        if (lakeId == null) {
            return;
        }
        LakeWorld world = worlds.get(lakeId);
        if (world == null) {
            return;
        }
        world.removeBoat(boatId);
        if (world.isEmpty()) {
            // Last one out: drop the in-memory world and park the lake as inactive.
            worlds.remove(lakeId);
            lakeRepository.findById(UUID.fromString(lakeId)).ifPresent(lake -> {
                lake.setActive(false);
                lakeRepository.save(lake);
            });
        }
    }
}
