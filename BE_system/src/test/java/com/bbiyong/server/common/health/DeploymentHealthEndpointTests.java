package com.bbiyong.server.common.health;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 배포 헬스게이트가 로봇 연결 상태와 분리되어 있는지 검증한다.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:sqlite::memory:",
        "spring.datasource.driver-class-name=org.sqlite.JDBC",
        "spring.jpa.database-platform=org.hibernate.community.dialect.SQLiteDialect",
        "spring.jpa.hibernate.ddl-auto=create-drop",
        "spring.datasource.hikari.maximum-pool-size=1",
        "management.endpoint.health.group.deployment.include=db,diskSpace",
        "management.endpoint.health.group.deployment.show-details=never",
        "management.endpoint.health.group.deployment.show-components=never"
})
@AutoConfigureMockMvc
@DirtiesContext
class DeploymentHealthEndpointTests {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void deploymentHealthIsUpWithoutConnectedRobot() throws Exception {
        mockMvc.perform(get("/actuator/health/deployment"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("UP"));
    }

    @Test
    void globalHealthStillReportsDisconnectedRobot() throws Exception {
        mockMvc.perform(get("/actuator/health"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.status").value("DOWN"));
    }
}
