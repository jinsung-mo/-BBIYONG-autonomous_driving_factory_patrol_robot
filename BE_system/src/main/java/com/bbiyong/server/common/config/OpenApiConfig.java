package com.bbiyong.server.common.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Contact;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.License;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import io.swagger.v3.oas.models.servers.Server;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.List;

/**
 * SpringDoc OpenAPI 3.0 설정
 * Swagger UI: /swagger-ui.html
 * API Docs JSON: /v3/api-docs
 */
@Configuration
public class OpenApiConfig {

    @Value("${server.port:8080}")
    private String serverPort;

    @Bean
    public OpenAPI bbiyongOpenAPI() {
        // 서버 정보
        Server localServer = new Server()
                .url("http://localhost:" + serverPort)
                .description("Local Development Server");

        Server productionServer = new Server()
                .url("https://k11e101.p.ssafy.io")
                .description("Production Server");

        // API 메타데이터
        Info info = new Info()
                .title("BBIYONG (삐용) 통합 관제 시스템 API")
                .version("1.0.0")
                .description("""
                        ## 삐용 (BBIYONG) - 순찰 로봇 기반 화재 감지 및 관제 시스템

                        ### 주요 기능
                        - **로봇 관제**: 실시간 로봇 상태 조회, 제어 명령 (STOMP)
                        - **화재 감지**: 교차검증 기반 화재 이벤트 수신 및 알림
                        - **순찰 관리**: 순찰 경로 및 waypoint 관리
                        - **영상 스트리밍**: 듀얼 카메라 (RGB/열화상) 실시간 중계
                        - **2D 도면**: 맵 업로드, 도면 생성, 활성 맵 관리
                        - **설비 관리**: 분전반 등 설비 임계 온도 설정

                        ### 인증
                        - JWT Bearer Token 기반 인증/인가
                        - `/api/auth/login` 으로 토큰 발급 후 `Authorization: Bearer <token>` 헤더 사용

                        ### 실시간 통신
                        - **WebSocket (STOMP)**: `/ws-관제` 엔드포인트
                        - **구독 토픽**: `/topic/robots`, `/topic/alerts`, `/topic/video/{robotId}`, `/topic/nav`
                        - **제어 발행**: `/app/control/drive`, `/app/control/mode`, `/app/control/operation`

                        ### 개발팀
                        SSAFY 11기 자율 프로젝트 E101팀
                        """)
                .contact(new Contact()
                        .name("SSAFY E101 Team")
                        .email("bbiyong@ssafy.io"))
                .license(new License()
                        .name("MIT License")
                        .url("https://opensource.org/licenses/MIT"));

        // JWT 보안 스킴
        SecurityScheme securityScheme = new SecurityScheme()
                .type(SecurityScheme.Type.HTTP)
                .scheme("bearer")
                .bearerFormat("JWT")
                .in(SecurityScheme.In.HEADER)
                .name("Authorization")
                .description("JWT 토큰을 입력하세요 (Bearer 접두사 자동 추가)");

        SecurityRequirement securityRequirement = new SecurityRequirement()
                .addList("bearerAuth");

        return new OpenAPI()
                .info(info)
                .servers(List.of(localServer, productionServer))
                .components(new Components()
                        .addSecuritySchemes("bearerAuth", securityScheme))
                .addSecurityItem(securityRequirement);
    }
}
