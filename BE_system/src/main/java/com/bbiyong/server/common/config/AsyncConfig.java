package com.bbiyong.server.common.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * 비동기 이벤트 처리 설정. (S15P11E101-715)
 *
 * <p>화재/과열 경보 영속화(DB write)는 로봇 WSS 수신 스레드 위에서 동기로 실행되면
 * 커넥션 풀(개발 SQLite 는 1개) 경합 시 텔레메트리·영상 프레임 처리까지 블로킹된다.
 * 경보 저장을 전용 스레드로 넘겨 수신 경로에서 DB write 를 분리한다.
 *
 * <p>단일 스레드 executor 를 쓰는 이유: 경보 처리 순서(수신 순서)와
 * 중복억제(dedup) 판단의 직렬성을 그대로 보존하기 위함이다.
 */
@Configuration
@EnableAsync
public class AsyncConfig {

    public static final String ALERT_EXECUTOR = "alertTaskExecutor";

    @Bean(name = ALERT_EXECUTOR)
    public ThreadPoolTaskExecutor alertTaskExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(1);
        executor.setMaxPoolSize(1);
        executor.setQueueCapacity(200);
        executor.setThreadNamePrefix("alert-");
        // 큐 포화 시 호출 스레드(WSS 수신)가 직접 실행 - 경보 유실보다 일시 지연을 택한다.
        executor.setRejectedExecutionHandler(new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());
        executor.initialize();
        return executor;
    }
}
