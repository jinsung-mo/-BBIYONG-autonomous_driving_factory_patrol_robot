package com.bbiyong.server.auth.service;

import com.bbiyong.server.auth.domain.Role;
import com.bbiyong.server.auth.domain.User;
import com.bbiyong.server.auth.dto.UserSummaryResponse;
import com.bbiyong.server.auth.repository.UserRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;

/**
 * 관리자 전용 사용자 관리(권한 승격/강등, 목록 조회).
 *
 * <p>인가(관리자 여부)는 컨트롤러의 {@code @PreAuthorize} 에서 강제한다.
 */
@Service
public class AdminUserService {

    private final UserRepository userRepository;

    public AdminUserService(UserRepository userRepository) {
        this.userRepository = userRepository;
    }

    @Transactional(readOnly = true)
    public List<UserSummaryResponse> listUsers() {
        return userRepository.findAll().stream()
                .map(UserSummaryResponse::from)
                .toList();
    }

    /**
     * 대상 사용자의 권한을 변경한다(관리자 승격/강등).
     *
     * @throws ResponseStatusException 404 대상 사용자가 없을 때
     */
    @Transactional
    public UserSummaryResponse changeRole(String email, Role role) {
        User user = userRepository.findByEmail(email)
                .orElseThrow(() -> new ResponseStatusException(
                        HttpStatus.NOT_FOUND, "존재하지 않는 사용자입니다: " + email));
        user.setRole(role);
        userRepository.save(user);
        return UserSummaryResponse.from(user);
    }
}
