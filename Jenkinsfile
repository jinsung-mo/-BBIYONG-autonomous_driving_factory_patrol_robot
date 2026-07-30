def sendMattermostNotification(boolean success) {
    def branch = env.BRANCH_NAME ?: env.GIT_BRANCH ?: '브랜치 정보 없음'
    def commitMessage = sh(
        script: 'git log -1 --pretty=%s 2>/dev/null || true',
        returnStdout: true
    ).trim() ?: '커밋 메시지 정보 없음'
    def statusText = success ? '[CD] FE 배포 성공' : '[CD] FE 배포 실패'
    def iconEmoji = success ? ':jenkins1:' : ':angry_jenkins:'
    def text = "## ${iconEmoji} ${statusText}\n" +
        "**대상 브랜치:** `${branch}`\n" +
        "**최신 커밋:** ${commitMessage}"

    writeFile(
        file: 'mattermost-payload.json',
        text: groovy.json.JsonOutput.toJson([
            text      : text,
            username  : 'Jenkins',
            icon_emoji: iconEmoji
        ])
    )

    withCredentials([string(credentialsId: 'mattermost-webhook', variable: 'MM_WEBHOOK')]) {
        sh '''
            curl --silent --show-error --fail --request POST \\
              --header 'Content-Type: application/json' \\
              --data-binary @mattermost-payload.json \\
              "$MM_WEBHOOK" || true
        '''
    }
}

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
        success {
            script {
                sendMattermostNotification(true)
            }
        }
        failure {
            sh 'docker compose -f FE/bbiyong-react/compose.yaml logs --tail=100 || true'
            script {
                sendMattermostNotification(false)
            }
        }
    }
}
