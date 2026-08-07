package com.bbiyong.server.auth.repository;

import com.bbiyong.server.auth.domain.User;
import org.springframework.data.jpa.repository.JpaRepository;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

public interface UserRepository extends JpaRepository<User, Long> {

    Optional<User> findByEmail(String email);

    boolean existsByEmail(String email);

    /**
     * 아이디(이메일) 찾기용. 이름+생년월일로 후보를 좁힌 뒤, 휴대전화번호는 저장 형식(하이픈 유무)이
     * 환경마다 달라질 수 있어 서비스에서 숫자만 비교한다(형식 불일치로 못 찾는 일을 막는다).
     */
    List<User> findByNameAndBirthDate(String name, LocalDate birthDate);
}
