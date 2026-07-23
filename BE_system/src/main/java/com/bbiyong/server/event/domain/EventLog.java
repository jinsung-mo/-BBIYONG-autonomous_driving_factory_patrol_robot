package com.bbiyong.server.event.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

@Data
@NoArgsConstructor
@Entity
@Table(name = "event_logs")
public class EventLog {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long eventId;

    @Column(nullable = false)
    private String type; // "FIRE", "OVERHEAT", "SYSTEM"

    private String robotId;

    private Double x;
    private Double y;

    private Double confidence;
    private Double temperature;

    @Column(nullable = false)
    private Instant timestamp;

    @Column(nullable = false)
    private String status; // "UNRESOLVED", "RESOLVED"
}
