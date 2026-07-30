package com.bbiyong.server.auth.domain;

import jakarta.persistence.*;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;
import java.time.LocalDate;

@Data
@NoArgsConstructor
@Entity
@Table(name = "users")
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(nullable = false)
    private String passwordHash;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String role; // "ROLE_ADMIN"

    @Column(nullable = false)
    private Instant createdAt;

    // 회원가입 확장 필드(S15P11E101-498). 기존 데모 계정 보호를 위해 DB 레벨은 nullable,
    // 필수 여부는 SignupRequest 검증 단에서 강제한다.
    @Column(length = 20)
    private String phoneNumber; // 010-0000-0000

    private LocalDate birthDate;

    @Column(length = 10)
    private String gender; // MALE | FEMALE | NONE
}
