package com.sailboats.simulation.model;

public record ControlInput(
    String boatId,
    double rudder,
    double sailTrim,
    boolean anchored
) {
}
