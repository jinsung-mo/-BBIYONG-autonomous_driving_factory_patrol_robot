pipeline {
    agent any

    options {
        disableConcurrentBuilds()
        timestamps()
    }

    stages {
        stage('Test') {
            steps {
                dir('FE/bbiyong-react') {
                    sh 'npm ci'
                    sh 'npm run build'
                }
            }
        }

        stage('Deploy') {
            steps {
                sh 'docker compose -f FE/bbiyong-react/compose.yaml up -d --build'
            }
        }

        stage('Health Check') {
            steps {
                sh '''
                    for i in $(seq 1 30); do
                        if curl -fsS http://127.0.0.1:8082/; then
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
            sh 'docker compose -f FE/bbiyong-react/compose.yaml logs --tail=100 || true'
        }
    }
}
