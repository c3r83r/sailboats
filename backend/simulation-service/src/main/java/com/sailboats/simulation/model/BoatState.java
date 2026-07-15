package com.sailboats.simulation.model;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@AllArgsConstructor
@NoArgsConstructor
public class BoatState {
    private String boatId;
    private String name;
    private double x;
    private double y;
    private double heading;
    private double speed;
    private double rudder;
    private double sailTrim;
    private boolean anchored;
    // Combat state: hull integrity 0..100, sinking flag and timers.
    private double health;
    private boolean sunk;
    private long sunkAt;
    private long lastFireAt;
    // Throttles grounding damage so running aground grinds the hull gradually.
    private long lastGroundAt;
    // Scoreboard: confirmed sinks of other boats and times sunk.
    private int kills;
    private int deaths;
    // AI boat flag: true for server-controlled bots, false for human players.
    private boolean bot;
    // True once a human has fired a shot; bots only return fire on aggressors.
    private boolean hasFired;
    // Heel angle in degrees (signed: + = leaning to starboard, - = to port),
    // driven by the lateral rig force. Integrated smoothly each tick.
    private double heel;
    // Capsize (knockdown): true while the boat is laid flat by an over-heel; it
    // lies dead in the water until it rights itself after CAPSIZE_RECOVER_MS.
    private boolean capsized;
    private long capsizedAt;
}
