package com.bbiyong.server.scheduler.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

/**
 * 순찰 스케줄 생성/수정 요청
 */
@Data
public class PatrolScheduleRequest {

    @NotBlank(message = "스케줄 이름은 필수입니다.")
    private String name;

    @NotBlank(message = "로봇 ID는 필수입니다.")
    private String robotId;

    @NotBlank(message = "Cron 표현식은 필수입니다.")
    private String cronExpression;

    @NotNull(message = "활성화 여부는 필수입니다.")
    private Boolean enabled;
}
