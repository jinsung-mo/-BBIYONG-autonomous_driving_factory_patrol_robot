package com.bbiyong.server.notification.repository;

import com.bbiyong.server.notification.domain.NotificationSetting;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface NotificationSettingRepository extends JpaRepository<NotificationSetting, Long> {

    /**
     * 사용자의 알림 설정 조회
     */
    Optional<NotificationSetting> findByUserId(String userId);
}
