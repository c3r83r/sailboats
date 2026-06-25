package com.sailboats.simulation.service;

import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.domain.LakeEntity;
import com.sailboats.simulation.domain.LakeMemberEntity;
import com.sailboats.simulation.domain.LakeSize;
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
        // In-memory worlds are empty after a restart, so wipe stale assignments
        // and the ephemeral lakes; fresh lakes are created on demand when players
        // join or create them.
        memberRepository.deleteAllInBatch();
        lakeRepository.deleteAllInBatch();

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

    /** Place a freshly connected boat on a SMALL lake and return that lake's id. */
    @Transactional
    public String assignBoat(String boatId, String name) {
        synchronized (assignmentLock) {
            boatNames.put(boatId, sanitizeName(name));
            LakeEntity lake = findLakeWithSpace(null, LakeSize.SMALL)
                .orElseGet(() -> createLake(LakeSize.SMALL, true, resolveWind(null), null));
            joinLake(boatId, lake);
            return lake.getId().toString();
        }
    }

    /** Move a boat onto a specific existing lake chosen from the browser. */
    @Transactional
    public String joinExistingLake(String boatId, String lakeId) {
        synchronized (assignmentLock) {
            String currentId = boatToLake.get(boatId);
            if (lakeId == null || lakeId.equals(currentId)) {
                return currentId;
            }
            UUID uuid;
            try {
                uuid = UUID.fromString(lakeId);
            } catch (IllegalArgumentException ex) {
                return currentId;
            }
            LakeEntity lake = lakeRepository.findById(uuid).filter(LakeEntity::isActive).orElse(null);
            if (lake == null || memberRepository.countByLakeId(uuid) >= lake.getCapacity()) {
                return currentId; // gone or full: stay put
            }
            leaveCurrentLake(boatId);
            joinLake(boatId, lake);
            return lake.getId().toString();
        }
    }

    /** Create a brand-new lake of the given size and move the boat onto it. */
    @Transactional
    public String createAndJoinLake(String boatId, LakeSize size, boolean bots, Double windDirection, String name) {
        synchronized (assignmentLock) {
            LakeEntity lake = createLake(size, bots, resolveWind(windDirection), name);
            leaveCurrentLake(boatId);
            joinLake(boatId, lake);
            return lake.getId().toString();
        }
    }

    // Use the requested wind (normalised to 0..360) or a random direction.
    private double resolveWind(Double requested) {
        if (requested == null) {
            return ThreadLocalRandom.current().nextDouble() * 360.0;
        }
        double normalized = requested % 360.0;
        return normalized < 0 ? normalized + 360.0 : normalized;
    }

    /** Lightweight summary of every active lake for the browser UI. */
    public List<LakeSummary> listLakeSummaries() {
        synchronized (assignmentLock) {
            List<LakeSummary> out = new ArrayList<>();
            for (LakeEntity lake : lakeRepository.findAll()) {
                if (!lake.isActive()) {
                    continue;
                }
                int boats = (int) memberRepository.countByLakeId(lake.getId());
                out.add(new LakeSummary(lake.getId().toString(), lake.getName(),
                    lake.getSize().name(), boats, lake.getCapacity(), lake.isBotsEnabled()));
            }
            return out;
        }
    }

    public record LakeSummary(String id, String name, String size, int boats, int capacity, boolean bots) {
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

    /** True if this boat is already on a lake (used to resume a reconnecting player). */
    public boolean isAssigned(String boatId) {
        return boatToLake.containsKey(boatId);
    }

    /** The lake id a boat currently belongs to, or null. */
    public String lakeOf(String boatId) {
        return boatToLake.get(boatId);
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

    // The fullest active lake of the given size that still has a free slot.
    private Optional<LakeEntity> findLakeWithSpace(UUID excludeId, LakeSize size) {
        return lakeRepository.findAll().stream()
            .filter(LakeEntity::isActive)
            .filter(lake -> size == null || lake.getSize() == size)
            .filter(lake -> excludeId == null || !lake.getId().equals(excludeId))
            .filter(lake -> memberRepository.countByLakeId(lake.getId()) < lake.getCapacity())
            .max(Comparator.comparingLong(lake -> memberRepository.countByLakeId(lake.getId())));
    }

    private LakeEntity createLake(LakeSize size, boolean bots, double windDirection, String name) {
        LakeEntity lake = new LakeEntity();
        lake.setId(UUID.randomUUID());
        lake.setName(lakeName(name, size));
        lake.setSeed(ThreadLocalRandom.current().nextLong());
        lake.setSize(size);
        lake.setCapacity(size.getCapacity());
        lake.setBotsEnabled(bots);
        lake.setWindDirection(windDirection);
        lake.setActive(true);
        lake.setCreatedAt(OffsetDateTime.now());
        return lakeRepository.save(lake);
    }

    // The player's chosen lake name (sanitised), or a sensible default per size.
    private String lakeName(String raw, LakeSize size) {
        if (raw != null) {
            String cleaned = raw.replaceAll("[\\p{Cntrl}]", "").trim();
            if (!cleaned.isEmpty()) {
                return cleaned.length() > 30 ? cleaned.substring(0, 30) : cleaned;
            }
        }
        return switch (size) {
            case SMALL -> "Mały akwen";
            case MEDIUM -> "Średni akwen";
            case LARGE -> "Duży akwen";
        };
    }

    private void joinLake(String boatId, LakeEntity lake) {
        if (!lake.isActive()) {
            lake.setActive(true);
            lakeRepository.save(lake);
        }
        LakeWorld world = worlds.computeIfAbsent(lake.getId().toString(),
            id -> new LakeWorld(id, lake.getName(), lake.getCapacity(), lake.getSeed(),
                lake.getSize().getWorldWidth(), lake.getSize().getWorldHeight(),
                lake.getWindDirection(), lake.isBotsEnabled()));
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
        if (!world.hasHumans()) {
            // Last human out: drop the in-memory world (and its bots) and delete the
            // lake row so it vanishes from the browser.
            worlds.remove(lakeId);
            lakeRepository.deleteById(UUID.fromString(lakeId));
        }
    }
}
