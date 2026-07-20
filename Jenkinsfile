pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    stages {
        stage('Test') {
            steps {
                dir('BE_system') {
                    sh 'sh ./gradlew test --no-daemon'
                }
            }
        }

        stage('Deploy') {
            steps {
                dir('BE_system') {
                    sh 'docker compose up -d --build'
                }
            }
        }

        stage('Health Check') {
            steps {
                sh '''
                    for i in $(seq 1 30); do
                        if curl -fsS http://127.0.0.1:8081/actuator/health; then
                            exit 0
                        fi
                        sleep 2
                    done
                    exit 1
                '''
            }
        }
    }

    post {
        failure {
            sh 'docker compose -f BE_system/compose.yaml logs --tail=100 || true'
        }
    }
}
