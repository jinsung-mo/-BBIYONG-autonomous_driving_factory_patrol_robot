-- V1: 프로젝트 종료 시점(2026-08) 스키마 기준선
--
-- 팀 프로젝트 기간에는 스키마를 Hibernate ddl-auto=update로 관리했다. 이 파일은 그 결과를
-- MySQL 8에서 mysqldump --no-data로 뽑은 것이다(자동 생성 UNIQUE 이름만 읽기 쉽게 바꿈).
-- 이미 테이블이 있는 DB에서는 baseline-on-migrate로 이 버전을 건너뛰고 V2부터 적용한다.

CREATE TABLE `equipments` (
  `equipment_id` varchar(255) NOT NULL,
  `last_inspected_at` datetime(6) DEFAULT NULL,
  `last_temperature` double DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `status` varchar(255) NOT NULL,
  `threshold` double DEFAULT NULL,
  `x` double DEFAULT NULL,
  `y` double DEFAULT NULL,
  PRIMARY KEY (`equipment_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `event_logs` (
  `event_id` bigint NOT NULL AUTO_INCREMENT,
  `confidence` double DEFAULT NULL,
  `equipment_id` varchar(255) DEFAULT NULL,
  `level` varchar(255) DEFAULT NULL,
  `map_id` varchar(36) DEFAULT NULL,
  `message` varchar(1000) DEFAULT NULL,
  `message_id` varchar(64) DEFAULT NULL,
  `robot_id` varchar(255) DEFAULT NULL,
  `simulated` tinyint(1) NOT NULL DEFAULT '0',
  `status` varchar(255) NOT NULL,
  `temperature` double DEFAULT NULL,
  `threshold` double DEFAULT NULL,
  `timestamp` datetime(6) NOT NULL,
  `type` varchar(255) NOT NULL,
  `x` double DEFAULT NULL,
  `y` double DEFAULT NULL,
  PRIMARY KEY (`event_id`),
  UNIQUE KEY `uk_event_logs_message_id` (`message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `map_artifacts` (
  `id` varchar(36) NOT NULL,
  `active` bit(1) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL,
  `file_path` varchar(512) NOT NULL,
  `file_size_bytes` bigint DEFAULT NULL,
  `height_px` int DEFAULT NULL,
  `kind` varchar(255) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `originx` double DEFAULT NULL,
  `originy` double DEFAULT NULL,
  `origin_yaw` double DEFAULT NULL,
  `resolution` double DEFAULT NULL,
  `robot_id` varchar(255) DEFAULT NULL,
  `source_map_id` varchar(255) DEFAULT NULL,
  `storage_type` varchar(255) NOT NULL,
  `width_px` int DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `notification_deliveries` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `attempts` int NOT NULL,
  `created_at` datetime(6) NOT NULL,
  `dedupe_key` varchar(300) NOT NULL,
  `event_id` bigint NOT NULL,
  `last_error` varchar(500) DEFAULT NULL,
  `next_attempt_at` datetime(6) NOT NULL,
  `recipient_user_id` varchar(255) NOT NULL,
  `status` varchar(16) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_delivery_event_user` (`event_id`,`recipient_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `notification_settings` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `created_at` datetime(6) NOT NULL,
  `mattermost_channel` varchar(100) DEFAULT NULL,
  `mattermost_enabled` bit(1) NOT NULL,
  `mattermost_webhook_url` varchar(500) DEFAULT NULL,
  `min_severity` varchar(20) DEFAULT NULL,
  `updated_at` datetime(6) DEFAULT NULL,
  `user_id` varchar(255) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `patrol_schedules` (
  `schedule_id` bigint NOT NULL AUTO_INCREMENT,
  `created_at` datetime(6) DEFAULT NULL,
  `cron_expression` varchar(255) NOT NULL,
  `enabled` bit(1) NOT NULL,
  `last_executed` datetime(6) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `robot_id` varchar(255) NOT NULL,
  `updated_at` datetime(6) DEFAULT NULL,
  PRIMARY KEY (`schedule_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `robot_health_history` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `battery` double DEFAULT NULL,
  `comm_latency_ms` int DEFAULT NULL,
  `estop` varchar(255) DEFAULT NULL,
  `inference_fps` double DEFAULT NULL,
  `online` bit(1) DEFAULT NULL,
  `robot_id` varchar(255) NOT NULL,
  `status` varchar(255) DEFAULT NULL,
  `timestamp` datetime(6) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_robot_timestamp` (`robot_id`,`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `users` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `birth_date` date DEFAULT NULL,
  `created_at` datetime(6) NOT NULL,
  `email` varchar(255) NOT NULL,
  `gender` varchar(10) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `phone_number` varchar(20) DEFAULT NULL,
  `role` enum('ROLE_ADMIN','ROLE_USER') NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `video_clips` (
  `id` varchar(36) NOT NULL,
  `clip_type` varchar(255) NOT NULL,
  `created_at` datetime(6) NOT NULL,
  `duration_sec` int DEFAULT NULL,
  `ended_at` datetime(6) DEFAULT NULL,
  `event_id` bigint DEFAULT NULL,
  `file_path` varchar(512) NOT NULL,
  `file_size_bytes` bigint DEFAULT NULL,
  `robot_id` varchar(255) NOT NULL,
  `started_at` datetime(6) NOT NULL,
  `storage_type` varchar(255) NOT NULL,
  `thumbnail_path` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `waypoints` (
  `id` varchar(36) NOT NULL,
  `created_at` datetime(6) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `robot_id` varchar(255) DEFAULT NULL,
  `seq` int DEFAULT NULL,
  `x` double NOT NULL,
  `y` double NOT NULL,
  `yaw` double DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `zones` (
  `id` varchar(36) NOT NULL,
  `created_at` datetime(6) NOT NULL,
  `name` varchar(80) NOT NULL,
  `x1` double NOT NULL,
  `x2` double NOT NULL,
  `y1` double NOT NULL,
  `y2` double NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
